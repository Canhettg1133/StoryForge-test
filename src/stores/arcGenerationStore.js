/**
 * StoryForge — Arc Generation Store (Phase 5)
 * 
 * Manages the entire auto-generation workflow:
 * Setup → Generate Outline → Batch Draft → Feedback Loop
 * 
 * Phase 9 additions:
 *   - currentMacroArcId / currentArcId: kết nối arc generation với đại cục
 *   - commitOutlineOnly / commitDraftsToProject: tạo arc record thực sự, gán arc_id cho chapters
 *   - generateMacroMilestones: AI gợi ý 5-8 cột mốc từ ý tưởng tác giả
 *   - saveMacroMilestones: lưu cột mốc đã duyệt vào DB
 *   - auditArcAlignment: kiểm tra độ lệch arc hiện tại so với đại cục
 */
import { create } from 'zustand';
import aiService from '../services/ai/client';
import { buildPrompt } from '../services/ai/promptBuilder';
import modelRouter, { TASK_TYPES } from '../services/ai/router';
import { gatherContext } from '../services/ai/contextEngine';
import db from '../services/db/database';
import useProjectStore from './projectStore';
import { parseAIJsonValue, isPlainObject } from '../utils/aiJson';
import { buildProseBuffer } from '../utils/proseBuffer';

// Ensure router is injected (same pattern as aiStore.js)
aiService.setRouter(modelRouter);

function getNextOrderIndex(items) {
    return items.reduce((max, item) => {
        const order = Number.isFinite(item?.order_index) ? item.order_index : -1;
        return Math.max(max, order);
    }, -1) + 1;
}

function normalizeOutlineResult(parsed) {
    if (Array.isArray(parsed)) {
        return {
            arc_title: '',
            chapters: parsed.filter(isPlainObject),
        };
    }
    return isPlainObject(parsed) ? parsed : null;
}

// ─── Helper: tạo arc record trong DB ───
// Dùng chung cho commitOutlineOnly và commitDraftsToProject
// Trả về arcId vừa tạo
async function createArcRecord({ projectId, macroArcId, arcTitle, arcGoal, chapterStart, chapterEnd }) {
    const existingArcs = await db.arcs.where('project_id').equals(projectId).toArray();
    const arcOrderIndex = getNextOrderIndex(existingArcs);

    const arcId = await db.arcs.add({
        project_id: projectId,
        macro_arc_id: macroArcId || null,
        order_index: arcOrderIndex,
        title: arcTitle || 'Arc mới',
        summary: arcGoal || '',
        goal: arcGoal || '',
        chapter_start: chapterStart,
        chapter_end: chapterEnd,
        status: 'planned',
        power_level_start: '',
        power_level_end: '',
    });

    return arcId;
}

async function upsertChapterMetaForGeneratedChapter({
    chapterId,
    projectId,
    summary = '',
    rawText = '',
}) {
    if (!chapterId || !projectId) return;

    const now = Date.now();
    const proseBuffer = rawText ? buildProseBuffer(rawText) : '';
    const existing = await db.chapterMeta.where('chapter_id').equals(chapterId).first();

    if (existing) {
        const updates = { summary, updated_at: now };
        if (proseBuffer) updates.last_prose_buffer = proseBuffer;
        await db.chapterMeta.update(existing.id, updates);
        return;
    }

    await db.chapterMeta.add({
        chapter_id: chapterId,
        project_id: projectId,
        summary,
        last_prose_buffer: proseBuffer,
        emotional_state: null,
        tension_level: null,
        created_at: now,
        updated_at: now,
    });
}

const useArcGenStore = create((set, get) => ({
    // --- State ---
    // Bước 1: Thiết lập
    arcGoal: '',              // Mục tiêu của Arc (VD: "Main đi vào Bí cảnh X")
    arcChapterCount: 10,      // Số chương muốn tạo
    arcPacing: 'medium',      // slow | medium | fast
    arcMode: 'guided',        // guided (bán tự động) | auto (đột phá)

    // Phase 9: Liên kết với đại cục
    // currentMacroArcId: macro arc đang hoạt động (null = chưa có đại cục)
    // currentArcId: arc cụ thể đang viết (null = chưa tạo arc)
    currentMacroArcId: null,
    currentArcId: null,

    // Bước 2: Dàn ý đã sinh
    generatedOutline: null,   // { arc_title, chapters: [{title, summary, key_events, pacing}] }
    outlineStatus: 'idle',    // idle | generating | ready | error

    // Bước 3: Đắp thịt
    draftStatus: 'idle',      // idle | drafting | done | error
    draftProgress: { current: 0, total: 0 },
    draftResults: [],         // [{chapterIndex, title, content, wordCount, status}]

    // Phase 9: Grand Strategy state
    isSuggestingMilestones: false,    // đang gọi AI gợi ý cột mốc
    macroMilestoneSuggestions: null,  // kết quả gợi ý chưa lưu { milestones: [...] }
    isAuditingArc: false,             // đang kiểm tra độ lệch
    lastAuditResult: null,            // { aligned, drift_score, issues, suggestions }

    // --- Actions ---

    setArcConfig: (config) => set(config),

    resetArc: () => set({
        arcGoal: '', arcChapterCount: 10, arcPacing: 'medium', arcMode: 'guided',
        currentMacroArcId: null, currentArcId: null,
        generatedOutline: null, outlineStatus: 'idle',
        draftStatus: 'idle', draftProgress: { current: 0, total: 0 }, draftResults: [],
        isSuggestingMilestones: false, macroMilestoneSuggestions: null,
        isAuditingArc: false, lastAuditResult: null,
    }),

    // ═══════════════════════════════════════════
    // BƯỚC 2: Sinh Dàn Ý (Outline)
    // ═══════════════════════════════════════════
    generateOutline: async ({ projectId, chapterId, chapterIndex, genre }) => {
        set({ outlineStatus: 'generating' });
        try {
            const { arcGoal, arcChapterCount, arcPacing, arcMode, currentMacroArcId } = get();

            // Thu thập ngữ cảnh
            const ctx = await gatherContext({
                projectId, chapterId, chapterIndex, sceneId: null, sceneText: '', genre,
            });

            // Phase 9: Load macro arc context nếu có
            // Đưa thông tin đại cục vào goal để AI biết phạm vi nhiệm vụ
            let macroArcContext = '';
            if (currentMacroArcId) {
                try {
                    const macroArc = await db.macro_arcs.get(currentMacroArcId);
                    if (macroArc) {
                        macroArcContext = '\n\n[DAI CUC HIEN TAI]: ' + macroArc.title;
                        if (macroArc.description) macroArcContext += ' — ' + macroArc.description;
                        if (macroArc.chapter_from && macroArc.chapter_to) {
                            macroArcContext += '\n(Chuong ' + macroArc.chapter_from + ' den ' + macroArc.chapter_to + ')';
                        }
                        if (macroArc.emotional_peak) {
                            macroArcContext += '\nCam xuc can dat duoc: ' + macroArc.emotional_peak;
                        }
                    }
                } catch (e) {
                    console.warn('[ArcGen] Failed to load macro arc context (non-fatal):', e);
                }
            }

            // Nếu mode "auto" (đột phá), tự động chọn Plot Thread + Canon Fact
            let finalGoal = arcGoal;
            if (arcMode === 'auto') {
                const plotThreads = await db.plotThreads.where('project_id').equals(projectId).toArray();
                const activeThreads = plotThreads.filter(pt => pt.state === 'active');
                const canonFacts = await db.canonFacts.where('project_id').equals(projectId).toArray();
                const activeFacts = canonFacts.filter(f => f.status === 'active');

                // Weighted random: ưu tiên thread lâu chưa có beat
                let chosenThread = null;
                if (activeThreads.length > 0) {
                    const threadBeats = await db.threadBeats
                        .where('plot_thread_id').anyOf(activeThreads.map(t => t.id)).toArray();
                    const threadWeights = activeThreads.map(thread => {
                        const beats = threadBeats.filter(b => b.plot_thread_id === thread.id);
                        const lastBeatSceneId = beats.length > 0 ? Math.max(...beats.map(b => b.scene_id)) : 0;
                        return { thread, weight: Math.max(1, 100 - lastBeatSceneId) };
                    });

                    const totalWeight = threadWeights.reduce((sum, item) => sum + item.weight, 0);
                    let random = Math.random() * totalWeight;
                    for (const item of threadWeights) {
                        random -= item.weight;
                        if (random <= 0) { chosenThread = item.thread; break; }
                    }
                    if (!chosenThread) chosenThread = threadWeights[threadWeights.length - 1]?.thread;
                }

                // Chọn Canon Fact: ưu tiên character-related
                let chosenFact = null;
                if (activeFacts.length > 0) {
                    const relevantFacts = activeFacts.filter(f => f.subject_type === 'character');
                    chosenFact = relevantFacts.length > 0
                        ? relevantFacts[Math.floor(Math.random() * relevantFacts.length)]
                        : activeFacts[Math.floor(Math.random() * activeFacts.length)];
                }

                finalGoal = 'Tao 3 huong di bat ngo (plot twist) cho chuong tiep theo.';
                if (chosenThread) finalGoal += ' Tuyen truyen can phat trien: "' + chosenThread.title + '"';
                if (chosenThread?.description) finalGoal += ' (' + chosenThread.description + ')';
                if (chosenFact) finalGoal += '. Su that lien quan: "' + chosenFact.description + '"';
            }

            // Gắn macro arc context vào goal nếu có
            if (macroArcContext) {
                finalGoal = finalGoal + macroArcContext;
            }

            // Build prompt
            const messages = buildPrompt(TASK_TYPES.ARC_OUTLINE, {
                ...ctx,
                userPrompt: finalGoal,
                chapterCount: arcChapterCount,
                arcPacing: arcPacing,
            });

            // Gọi AI qua aiService.send() (đúng API)
            await new Promise((resolve) => {
                aiService.send({
                    taskType: TASK_TYPES.ARC_OUTLINE,
                    messages,
                    stream: true,
                    onToken: () => { },
                    onComplete: (text) => {
                        try {
                            const parsed = parseAIJsonValue(text);
                            const outline = normalizeOutlineResult(parsed);
                            if (!outline) throw new Error('Unexpected outline format');
                            set({ generatedOutline: outline, outlineStatus: 'ready' });
                        } catch (e) {
                            console.error('Failed to parse outline JSON:', e, text);
                            set({ outlineStatus: 'error' });
                        }
                        resolve();
                    },
                    onError: (err) => {
                        console.error('Outline generation error:', err);
                        set({ outlineStatus: 'error' });
                        resolve();
                    },
                });
            });
        } catch (err) {
            console.error('generateOutline failed:', err);
            set({ outlineStatus: 'error' });
        }
    },

    // Tác giả chỉnh sửa dàn ý
    updateOutlineChapter: (index, updates) => {
        const { generatedOutline } = get();
        if (!generatedOutline) return;
        const newChapters = [...generatedOutline.chapters];
        newChapters[index] = { ...newChapters[index], ...updates };
        set({ generatedOutline: { ...generatedOutline, chapters: newChapters } });
    },

    removeOutlineChapter: (index) => {
        const { generatedOutline } = get();
        if (!generatedOutline) return;
        const newChapters = generatedOutline.chapters.filter((_, i) => i !== index);
        set({ generatedOutline: { ...generatedOutline, chapters: newChapters } });
    },

    // ═══════════════════════════════════════════
    // BƯỚC 4: Đắp thịt (Batch Generation)
    // ═══════════════════════════════════════════
    startBatchDraft: async ({ projectId, genre, startingChapterIndex }) => {
        const { generatedOutline } = get();
        if (!generatedOutline || !generatedOutline.chapters) return;

        const chapters = generatedOutline.chapters;
        let generatedBridgeBuffer = '';
        set({
            draftStatus: 'drafting',
            draftProgress: { current: 0, total: chapters.length },
            draftResults: chapters.map((ch, i) => ({
                chapterIndex: startingChapterIndex + i,
                title: ch.title,
                content: '',
                wordCount: 0,
                status: 'pending',
            })),
        });

        for (let i = 0; i < chapters.length; i++) {
            const { draftStatus } = get();
            if (draftStatus === 'idle') break; // Cancelled

            const ch = chapters[i];
            const chapterIdx = startingChapterIndex + i;

            try {
                const ctx = await gatherContext({
                    projectId, chapterId: null, chapterIndex: chapterIdx,
                    sceneId: null, sceneText: generatedBridgeBuffer, genre,
                });
                const previousGeneratedSummary = i > 0 ? (chapters[i - 1]?.summary || '') : '';

                const messages = buildPrompt(TASK_TYPES.ARC_CHAPTER_DRAFT, {
                    ...ctx,
                    previousSummary: previousGeneratedSummary || ctx.previousSummary,
                    bridgeBuffer: generatedBridgeBuffer || ctx.bridgeBuffer,
                    chapterOutlineTitle: ch.title,
                    chapterOutlineSummary: ch.summary,
                    chapterOutlineEvents: ch.key_events || [],
                });

                // Dùng aiService.send() — await bằng Promise wrapper
                await new Promise((resolve) => {
                    aiService.send({
                        taskType: TASK_TYPES.ARC_CHAPTER_DRAFT,
                        messages,
                        stream: true,
                        onToken: (chunk, fullText) => {
                            // Optionally update live preview in future
                        },
                        onComplete: (text) => {
                            const wordCount = text.split(/\s+/).filter(Boolean).length;
                            generatedBridgeBuffer = buildProseBuffer(text);
                            set(state => ({
                                draftProgress: { ...state.draftProgress, current: i + 1 },
                                draftResults: state.draftResults.map((r, idx) =>
                                    idx === i ? { ...r, content: text, wordCount, status: 'done' } : r
                                ),
                            }));
                            resolve();
                        },
                        onError: (err) => {
                            console.error(`Draft chapter ${i} error:`, err);
                            set(state => ({
                                draftProgress: { ...state.draftProgress, current: i + 1 },
                                draftResults: state.draftResults.map((r, idx) =>
                                    idx === i ? { ...r, status: 'error' } : r
                                ),
                            }));
                            resolve(); // Continue to next chapter
                        },
                    });
                });
            } catch (err) {
                console.error(`Draft chapter ${i} exception:`, err);
                set(state => ({
                    draftProgress: { ...state.draftProgress, current: i + 1 },
                    draftResults: state.draftResults.map((r, idx) =>
                        idx === i ? { ...r, status: 'error' } : r
                    ),
                }));
            }
        }

        set(s => {
            if (s.draftStatus === 'drafting') return { draftStatus: 'done' };
            return {};
        });
    },

    cancelDraft: () => set({ draftStatus: 'idle' }),

    // ═══════════════════════════════════════════
    // Lưu Dàn Ý Only (không đắp thịt)
    // Phase 9: Tạo arc record thực sự + gán arc_id cho chapters
    // ═══════════════════════════════════════════
    commitOutlineOnly: async (projectId) => {
        const { generatedOutline, currentMacroArcId, arcGoal } = get();
        if (!generatedOutline?.chapters) return;

        const { chapters } = useProjectStore.getState();
        const baseIndex = getNextOrderIndex(chapters);
        const chapterCount = generatedOutline.chapters.length;

        // Phase 9: Tạo arc record trước, lấy arcId để gán cho chapters
        const arcId = await createArcRecord({
            projectId,
            macroArcId: currentMacroArcId,
            arcTitle: generatedOutline.arc_title || arcGoal || 'Arc mới',
            arcGoal: arcGoal,
            chapterStart: baseIndex + 1,
            chapterEnd: baseIndex + chapterCount,
        });

        // Lưu arcId vào store để UI có thể tham chiếu
        set({ currentArcId: arcId });

        for (let i = 0; i < chapterCount; i++) {
            const ch = generatedOutline.chapters[i];
            const chapterId = await db.chapters.add({
                project_id: projectId,
                arc_id: arcId,        // Phase 9: gán đúng arc_id thay vì null
                order_index: baseIndex + i,
                title: ch.title,
                summary: ch.summary || '',
                purpose: JSON.stringify(ch.key_events || []),
                status: 'outline',
                word_count_target: 7000,
                actual_word_count: 0,
            });

            await db.scenes.add({
                project_id: projectId,
                chapter_id: chapterId,
                order_index: 0,
                title: 'Cảnh 1',
                summary: '',
                pov_character_id: null,
                location_id: null,
                time_marker: '',
                goal: '',
                conflict: '',
                emotional_start: '',
                emotional_end: '',
                status: 'outline',
                draft_text: '',
                final_text: '',
            });

            await upsertChapterMetaForGeneratedChapter({
                chapterId,
                projectId,
                summary: ch.summary || '',
            });
        }

        await useProjectStore.getState().loadProject(projectId);
    },

    // ═══════════════════════════════════════════
    // Lưu kết quả vào Database
    // Phase 9: Tạo arc record thực sự + gán arc_id cho chapters
    // ═══════════════════════════════════════════
    commitDraftsToProject: async (projectId) => {
        const { draftResults, generatedOutline, currentMacroArcId, arcGoal } = get();
        const { chapters } = useProjectStore.getState();
        const baseIndex = getNextOrderIndex(chapters);

        const doneDrafts = draftResults.filter(d => d.status === 'done' && d.content);
        if (doneDrafts.length === 0) return;

        // Phase 9: Tạo arc record trước, lấy arcId để gán cho chapters
        const arcId = await createArcRecord({
            projectId,
            macroArcId: currentMacroArcId,
            arcTitle: generatedOutline?.arc_title || arcGoal || 'Arc mới',
            arcGoal: arcGoal,
            chapterStart: baseIndex + 1,
            chapterEnd: baseIndex + doneDrafts.length,
        });

        // Lưu arcId vào store để UI có thể tham chiếu
        set({ currentArcId: arcId });

        let createdCount = 0;

        for (let di = 0; di < draftResults.length; di++) {
            const draft = draftResults[di];
            if (draft.status !== 'done' || !draft.content) continue;

            const chapterId = await db.chapters.add({
                project_id: projectId,
                arc_id: arcId,        // Phase 9: gán đúng arc_id thay vì null
                order_index: baseIndex + createdCount,
                title: draft.title,
                summary: generatedOutline.chapters[di]?.summary || '',
                purpose: '',
                status: 'draft',
                word_count_target: 7000,
                actual_word_count: draft.wordCount,
            });
            createdCount++;

            await db.scenes.add({
                project_id: projectId,
                chapter_id: chapterId,
                order_index: 0,
                title: 'Cảnh 1',
                summary: '',
                pov_character_id: null,
                location_id: null,
                time_marker: '',
                goal: '',
                conflict: '',
                emotional_start: '',
                emotional_end: '',
                status: 'draft',
                draft_text: draft.content,
                final_text: '',
            });

            await upsertChapterMetaForGeneratedChapter({
                chapterId,
                projectId,
                summary: generatedOutline.chapters[di]?.summary || '',
                rawText: draft.content,
            });
        }

        await useProjectStore.getState().loadProject(projectId);
    },

    // ═══════════════════════════════════════════
    // PHASE 3: Feedback Loop
    // ═══════════════════════════════════════════
    flagChapter: (index, note) => {
        set(state => ({
            draftResults: state.draftResults.map((r, i) => {
                if (i !== index) return r;
                // If note is empty/falsy, unflag (revert to done)
                if (!note) return { ...r, status: 'done', flagNote: '' };
                return { ...r, status: 'flagged', flagNote: note };
            }),
        }));
    },

    regenerateFromIndex: async ({ projectId, genre, fromIndex, startingChapterIndex }) => {
        const { generatedOutline, draftResults } = get();
        if (!generatedOutline) return;

        const chapters = generatedOutline.chapters;

        set(state => ({
            draftStatus: 'drafting',
            draftProgress: { current: fromIndex, total: chapters.length },
            draftResults: state.draftResults.map((r, i) =>
                i >= fromIndex ? { ...r, content: '', wordCount: 0, status: 'pending' } : r
            ),
        }));

        let regeneratedBridgeBuffer = '';

        for (let i = fromIndex; i < chapters.length; i++) {
            const { draftStatus } = get();
            if (draftStatus === 'idle') break;

            const ch = chapters[i];
            const chapterIdx = startingChapterIndex + i;

            // Lấy nội dung các chương trước đã OK làm context
            const currentResults = get().draftResults;
            const previousContent = currentResults
                .filter((r, idx) => idx < i && r.status === 'done')
                .map(r => r.content)
                .join('\n\n');

            try {
                const ctx = await gatherContext({
                    projectId, chapterId: null, chapterIndex: chapterIdx,
                    sceneId: null, sceneText: previousContent.slice(-3000), genre,
                });

                const flagNote = currentResults[i]?.flagNote || '';
                const previousGeneratedSummary = i > 0 ? (chapters[i - 1]?.summary || '') : '';
                const previousBridgeBuffer = regeneratedBridgeBuffer
                    || buildProseBuffer(previousContent)
                    || ctx.bridgeBuffer;
                const messages = buildPrompt(TASK_TYPES.ARC_CHAPTER_DRAFT, {
                    ...ctx,
                    previousSummary: previousGeneratedSummary || ctx.previousSummary,
                    bridgeBuffer: previousBridgeBuffer,
                    chapterOutlineTitle: ch.title,
                    chapterOutlineSummary: ch.summary + (flagNote ? '. GHI CHU SUA DOI: ' + flagNote : ''),
                    chapterOutlineEvents: ch.key_events || [],
                });

                await new Promise((resolve) => {
                    aiService.send({
                        taskType: TASK_TYPES.ARC_CHAPTER_DRAFT,
                        messages,
                        stream: true,
                        onToken: () => { },
                        onComplete: (text) => {
                            const wordCount = text.split(/\s+/).filter(Boolean).length;
                            regeneratedBridgeBuffer = buildProseBuffer(text);
                            set(state => ({
                                draftProgress: { ...state.draftProgress, current: i + 1 },
                                draftResults: state.draftResults.map((r, idx) =>
                                    idx === i ? { ...r, content: text, wordCount, status: 'done', flagNote: '' } : r
                                ),
                            }));
                            resolve();
                        },
                        onError: (err) => {
                            console.error(`Regen chapter ${i} error:`, err);
                            set(state => ({
                                draftProgress: { ...state.draftProgress, current: i + 1 },
                                draftResults: state.draftResults.map((r, idx) =>
                                    idx === i ? { ...r, status: 'error' } : r
                                ),
                            }));
                            resolve();
                        },
                    });
                });
            } catch (err) {
                console.error(`Regen chapter ${i} exception:`, err);
                set(state => ({
                    draftProgress: { ...state.draftProgress, current: i + 1 },
                    draftResults: state.draftResults.map((r, idx) =>
                        idx === i ? { ...r, status: 'error' } : r
                    ),
                }));
            }
        }

        set(s => {
            if (s.draftStatus === 'drafting') return { draftStatus: 'done' };
            return {};
        });
    },

    // ═══════════════════════════════════════════
    // Phase 9: Grand Strategy Actions
    // ═══════════════════════════════════════════

    /**
     * AI gợi ý 5-8 cột mốc lớn cho toàn bộ truyện.
     * Kết quả lưu vào `macroMilestoneSuggestions` để tác giả duyệt.
     * Tác giả duyệt xong → gọi `saveMacroMilestones` để lưu vào DB.
     *
     * @param {object} params
     * @param {number} params.projectId
     * @param {string} params.authorIdea   - Ý tưởng tổng thể của tác giả (vài câu)
     * @param {string} params.genre
     */
    generateMacroMilestones: async ({ projectId, authorIdea, genre }) => {
        set({ isSuggestingMilestones: true, macroMilestoneSuggestions: null });

        try {
            const project = await db.projects.get(projectId);
            const targetLength = project?.target_length || 0;
            const ultimateGoal = project?.ultimate_goal || '';

            // Build prompt trực tiếp — task này chưa có entry trong promptBuilder
            // nên dùng messages array thủ công theo đúng format Gemini
            const systemInstruction = [
                'Ban la nha hoach dinh co cau truyen chuyen nghiep cho tieu thuyet dai ky (500-1000 chuong).',
                'Nhiem vu: Tao 5-8 cot moc lon (Macro Milestones) de tac gia dung lam "ban do" cho toan bo tac pham.',
                'Moi cot moc la mot diem ngoat lon trong hanh trinh nhan vat — khong phai tiet tiet nho.',
                'Phan bo cot moc phai dam bao truyen co CAO TRAO, KHUNG HOANG va GIAI QUYET ro rang.',
                'Tra ve CHINH XAC JSON format sau, KHONG them gi khac:',
                '{',
                '  "milestones": [',
                '    {',
                '      "order": 1,',
                '      "title": "Ten cot moc ngan gon",',
                '      "description": "Mo ta 2-3 cau ve nhung gi xay ra o cot moc nay",',
                '      "chapter_from": 1,',
                '      "chapter_to": 80,',
                '      "emotional_peak": "Doc gia can cam thay gi khi ket thuc cot moc nay"',
                '    }',
                '  ]',
                '}',
            ].join('\n');

            const userContent = [
                'Y tuong truyen: ' + (authorIdea || '(Chua co y tuong cu the)'),
                'The loai: ' + (genre || 'Chua xac dinh'),
                targetLength > 0 ? 'Do dai du kien: ' + targetLength + ' chuong' : '',
                ultimateGoal ? 'Muc tieu cuoi cung cua truyen: ' + ultimateGoal : '',
                '',
                'Hay phan tich y tuong tren va de xuat 5-8 cot moc phu hop.',
                'Dam bao chuong ket thuc moi cot moc khop voi do dai truyen.',
            ].filter(Boolean).join('\n');

            const messages = [
                { role: 'system', content: systemInstruction },
                { role: 'user', content: userContent },
            ];

            await new Promise((resolve) => {
                aiService.send({
                    taskType: TASK_TYPES.GENERATE_MACRO_MILESTONES,
                    messages,
                    stream: false,
                    onComplete: (text) => {
                        try {
                            const parsed = parseAIJsonValue(text);
                            if (!isPlainObject(parsed) || !Array.isArray(parsed.milestones)) {
                                throw new Error('Invalid milestones format');
                            }
                            set({ macroMilestoneSuggestions: parsed, isSuggestingMilestones: false });
                        } catch (e) {
                            console.error('[ArcGen] Failed to parse milestones:', e, text);
                            set({ isSuggestingMilestones: false });
                        }
                        resolve();
                    },
                    onError: (err) => {
                        console.error('[ArcGen] generateMacroMilestones error:', err);
                        set({ isSuggestingMilestones: false });
                        resolve();
                    },
                });
            });
        } catch (err) {
            console.error('[ArcGen] generateMacroMilestones failed:', err);
            set({ isSuggestingMilestones: false });
        }
    },

    /**
     * Lưu các cột mốc đã tác giả duyệt vào DB (bảng macro_arcs).
     * Gọi sau khi tác giả review `macroMilestoneSuggestions` và confirm.
     *
     * @param {number} projectId
     * @param {Array}  milestones - mảng đã chỉnh sửa từ macroMilestoneSuggestions
     * @returns {Promise<number[]>} mảng các id vừa tạo
     */
    saveMacroMilestones: async (projectId, milestones) => {
        if (!milestones || milestones.length === 0) return [];

        const createdIds = [];
        for (let i = 0; i < milestones.length; i++) {
            const m = milestones[i];
            const id = await db.macro_arcs.add({
                project_id: projectId,
                order_index: i,
                title: m.title || '',
                description: m.description || '',
                chapter_from: m.chapter_from || 0,
                chapter_to: m.chapter_to || 0,
                emotional_peak: m.emotional_peak || '',
            });
            createdIds.push(id);
        }

        // Xóa suggestions khỏi store sau khi đã lưu
        set({ macroMilestoneSuggestions: null });
        return createdIds;
    },

    /**
     * Kiểm tra độ lệch của arc đang viết so với đại cục.
     * Nên gọi sau mỗi 10 chương hoàn thành.
     * Kết quả lưu vào `lastAuditResult`.
     *
     * @param {object} params
     * @param {number} params.projectId
     * @param {string} params.genre
     * @param {number} params.currentChapterIndex - index chương hiện tại
     */
    auditArcAlignment: async ({ projectId, genre, currentChapterIndex }) => {
        set({ isAuditingArc: true, lastAuditResult: null });

        try {
            const project = await db.projects.get(projectId);
            const ultimateGoal = project?.ultimate_goal || '';
            const targetLength = project?.target_length || 0;

            // Lấy 10 chapter summary gần nhất
            const allChapters = await db.chapters
                .where('project_id').equals(projectId)
                .sortBy('order_index');
            const recentChapters = allChapters
                .filter(c => c.order_index <= currentChapterIndex)
                .slice(-10);
            const recentMetas = await Promise.all(
                recentChapters.map(c =>
                    db.chapterMeta.where('chapter_id').equals(c.id).first()
                )
            );
            const recentSummaries = recentChapters.map((c, i) => ({
                title: c.title,
                summary: recentMetas[i]?.summary || c.summary || '',
            }));

            // Lấy macro arc và arc hiện tại
            const { currentMacroArcId, currentArcId } = get();
            let macroArcInfo = null;
            let currentArcInfo = null;

            if (currentMacroArcId) {
                try { macroArcInfo = await db.macro_arcs.get(currentMacroArcId); } catch { }
            }
            if (currentArcId) {
                try { currentArcInfo = await db.arcs.get(currentArcId); } catch { }
            }

            // Build prompt kiểm tra độ lệch
            const systemInstruction = [
                'Ban la bien tap vien kiem soat chat luong tieu thuyet dai ky.',
                'Nhiem vu: Phan tich xem noi dung cac chuong gan day co dang di dung huong so voi dai cuc khong.',
                'Chi ra DO LECH cu the neu co, dung noi chung chung.',
                '',
                'Tra ve CHINH XAC JSON format sau:',
                '{',
                '  "aligned": true/false,',
                '  "drift_score": 0-10,',
                '  "issues": ["Van de 1", "Van de 2"],',
                '  "suggestions": ["De xuat sua 1", "De xuat sua 2"],',
                '  "current_position": "Mo ta vi tri hien tai cua truyen trong 1 cau"',
                '}',
                'drift_score: 0 = hoan toan dung huong, 10 = lac qua xa.',
                'Chi tra ve JSON, KHONG them gi khac.',
            ].join('\n');

            const summaryText = recentSummaries.length > 0
                ? recentSummaries.map((s, i) => (i + 1) + '. ' + s.title + ': ' + (s.summary || '(chua co tom tat)')).join('\n')
                : '(Chua co chuong nao hoan thanh)';

            const userContent = [
                '[10 CHUONG GAN NHAT]',
                summaryText,
                '',
                '[DAI CUC / MUC TIEU TONG THE]',
                ultimateGoal ? 'Muc tieu: ' + ultimateGoal : '(Chua dinh nghia)',
                targetLength > 0 ? 'Do dai: ' + targetLength + ' chuong, hien tai o chuong ' + (currentChapterIndex + 1) : '',
                macroArcInfo ? 'Cot moc dang o: ' + macroArcInfo.title + (macroArcInfo.description ? ' — ' + macroArcInfo.description : '') : '',
                '',
                '[ARC HIEN TAI]',
                currentArcInfo ? 'Muc tieu arc: ' + (currentArcInfo.goal || currentArcInfo.title || '(chua dinh nghia)') : '(Chua co arc)',
                '',
                'Hay phan tich va tra ve ket qua kiem tra do lech.',
            ].filter(Boolean).join('\n');

            const messages = [
                { role: 'system', content: systemInstruction },
                { role: 'user', content: userContent },
            ];

            await new Promise((resolve) => {
                aiService.send({
                    taskType: TASK_TYPES.AUDIT_ARC_ALIGNMENT,
                    messages,
                    stream: false,
                    onComplete: (text) => {
                        try {
                            const parsed = parseAIJsonValue(text);
                            if (!isPlainObject(parsed)) throw new Error('Invalid audit format');
                            set({ lastAuditResult: parsed, isAuditingArc: false });
                        } catch (e) {
                            console.error('[ArcGen] Failed to parse audit result:', e, text);
                            set({ isAuditingArc: false });
                        }
                        resolve();
                    },
                    onError: (err) => {
                        console.error('[ArcGen] auditArcAlignment error:', err);
                        set({ isAuditingArc: false });
                        resolve();
                    },
                });
            });
        } catch (err) {
            console.error('[ArcGen] auditArcAlignment failed:', err);
            set({ isAuditingArc: false });
        }
    },
}));

export default useArcGenStore;
