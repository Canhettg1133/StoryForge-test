/**
 * StoryForge — Scene Detail Panel (Drawer)
 *
 * A right-side drawer panel for editing the active scene's metadata:
 * goal, conflict, emotional arc, pacing, must_happen, must_not_happen, characters_present.
 * Mirrors the scene fields from ChapterDetailModal but focuses on a single scene.
 */

import React, { useState, useEffect } from 'react';
import {
  X, Save, Target, Zap, Heart, Clock, Shield, Users, Plus, Trash2
} from 'lucide-react';

const PACING_OPTIONS = [
  { value: '', label: '— Chưa chọn —' },
  { value: 'slow', label: 'Slow — Chậm, mô tả' },
  { value: 'medium', label: 'Medium — Cân bằng' },
  { value: 'fast', label: 'Fast — Nhanh, hành động' },
];

export default function SceneDetailPanel({
  scene,
  characters = [],
  onSave,
  onClose,
}) {
  const [form, setForm] = useState({
    goal: '',
    conflict: '',
    emotional_start: '',
    emotional_end: '',
    pacing: '',
    must_happen: [],
    must_not_happen: [],
    characters_present: [],
    must_happen_input: '',
    must_not_happen_input: '',
  });
  const [saving, setSaving] = useState(false);

  // Initialize form from scene
  useEffect(() => {
    if (!scene) return;
    let mustHappen = [];
    let mustNotHappen = [];
    let charsPresent = [];
    try { mustHappen = JSON.parse(scene.must_happen || '[]'); } catch { }
    try { mustNotHappen = JSON.parse(scene.must_not_happen || '[]'); } catch { }
    try { charsPresent = JSON.parse(scene.characters_present || '[]'); } catch { }

    setForm({
      goal: scene.goal || '',
      conflict: scene.conflict || '',
      emotional_start: scene.emotional_start || '',
      emotional_end: scene.emotional_end || '',
      pacing: scene.pacing || '',
      must_happen: Array.isArray(mustHappen) ? mustHappen : [],
      must_not_happen: Array.isArray(mustNotHappen) ? mustNotHappen : [],
      characters_present: Array.isArray(charsPresent) ? charsPresent : [],
      must_happen_input: '',
      must_not_happen_input: '',
    });
  }, [scene?.id]);

  const handleSave = async () => {
    setSaving(true);
    try {
      await onSave({
        goal: form.goal,
        conflict: form.conflict,
        emotional_start: form.emotional_start,
        emotional_end: form.emotional_end,
        pacing: form.pacing,
        must_happen: JSON.stringify(form.must_happen),
        must_not_happen: JSON.stringify(form.must_not_happen),
        characters_present: JSON.stringify(form.characters_present),
      });
    } finally {
      setSaving(false);
    }
  };

  const addMustHappen = () => {
    const val = form.must_happen_input.trim();
    if (val) setForm(f => ({ ...f, must_happen: [...f.must_happen, val], must_happen_input: '' }));
  };

  const removeMustHappen = (i) => {
    setForm(f => ({ ...f, must_happen: f.must_happen.filter((_, idx) => idx !== i) }));
  };

  const addMustNotHappen = () => {
    const val = form.must_not_happen_input.trim();
    if (val) setForm(f => ({ ...f, must_not_happen: [...f.must_not_happen, val], must_not_happen_input: '' }));
  };

  const removeMustNotHappen = (i) => {
    setForm(f => ({ ...f, must_not_happen: f.must_not_happen.filter((_, idx) => idx !== i) }));
  };

  const toggleChar = (charId) => {
    setForm(f => ({
      ...f,
      characters_present: f.characters_present.includes(charId)
        ? f.characters_present.filter(id => id !== charId)
        : [...f.characters_present, charId],
    }));
  };

  return (
    <>
      {/* Backdrop */}
      <div className="scene-detail-backdrop" onClick={onClose} />

      {/* Drawer */}
      <div className="scene-detail-panel">
        {/* Header */}
        <div className="scene-detail-header">
          <div className="scene-detail-title">
            <Target size={15} />
            <span>Chi tiết cảnh</span>
            {scene?.title && (
              <span className="scene-detail-scene-name">— {scene.title}</span>
            )}
          </div>
          <div className="scene-detail-actions">
            <button
              className="btn btn-primary btn-sm"
              onClick={handleSave}
              disabled={saving}
            >
              <Save size={13} /> {saving ? 'Đang lưu...' : 'Lưu'}
            </button>
            <button className="btn btn-ghost btn-sm btn-icon" onClick={onClose}>
              <X size={15} />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="scene-detail-body">
          {/* Mục tiêu cảnh */}
          <div className="scene-detail-field">
            <label className="scene-detail-label">
              <Target size={13} />
              Mục tiêu cảnh
            </label>
            <textarea
              className="scene-detail-textarea"
              rows={2}
              placeholder="Cảnh này cần đạt được gì? (VD: Nhân vật khám phá bí mật, tìm kiếm manh mối...)"
              value={form.goal}
              onChange={e => setForm(f => ({ ...f, goal: e.target.value }))}
            />
          </div>

          {/* Xung đột */}
          <div className="scene-detail-field">
            <label className="scene-detail-label">
              <Shield size={13} />
              Xung đột
            </label>
            <textarea
              className="scene-detail-textarea"
              rows={2}
              placeholder="Xung đột chính của cảnh là gì? (VD: Nhân vật bị truy đuổi, đối mặt kẻ thù...)"
              value={form.conflict}
              onChange={e => setForm(f => ({ ...f, conflict: e.target.value }))}
            />
          </div>

          {/* Cảm xúc bắt đầu / kết thúc */}
          <div className="scene-detail-field-row">
            <div className="scene-detail-field">
              <label className="scene-detail-label">
                <Heart size={13} />
                Cảm xúc bắt đầu
              </label>
              <textarea
                className="scene-detail-textarea"
                rows={2}
                placeholder="Trạng thái cảm xúc lúc bắt đầu cảnh"
                value={form.emotional_start}
                onChange={e => setForm(f => ({ ...f, emotional_start: e.target.value }))}
              />
            </div>
            <div className="scene-detail-field">
              <label className="scene-detail-label">
                <Heart size={13} />
                Cảm xúc kết thúc
              </label>
              <textarea
                className="scene-detail-textarea"
                rows={2}
                placeholder="Trạng thái cảm xúc lúc kết thúc cảnh"
                value={form.emotional_end}
                onChange={e => setForm(f => ({ ...f, emotional_end: e.target.value }))}
              />
            </div>
          </div>

          {/* Nhịp độ */}
          <div className="scene-detail-field">
            <label className="scene-detail-label">
              <Zap size={13} />
              Nhịp độ
            </label>
            <select
              className="scene-detail-select"
              value={form.pacing}
              onChange={e => setForm(f => ({ ...f, pacing: e.target.value }))}
            >
              {PACING_OPTIONS.map(opt => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </div>

          {/* Nhân vật có mặt */}
          {characters.length > 0 && (
            <div className="scene-detail-field">
              <label className="scene-detail-label">
                <Users size={13} />
                Nhân vật có mặt
              </label>
              <div className="scene-detail-char-list">
                {characters.map(char => (
                  <label key={char.id} className="scene-detail-char-item">
                    <input
                      type="checkbox"
                      checked={form.characters_present.includes(char.id)}
                      onChange={() => toggleChar(char.id)}
                    />
                    <span>{char.name}</span>
                    {char.role && <span className="scene-detail-char-role">({char.role})</span>}
                  </label>
                ))}
              </div>
            </div>
          )}

          {/* Phải xảy ra */}
          <div className="scene-detail-field">
            <label className="scene-detail-label">
              <Plus size={13} />
              Phải xảy ra (must happen)
            </label>
            <div className="scene-detail-tag-list">
              {form.must_happen.map((item, i) => (
                <div key={i} className="scene-detail-tag scene-detail-tag--danger">
                  <span>{item}</span>
                  <button onClick={() => removeMustHappen(i)} className="scene-detail-tag-remove">
                    <X size={10} />
                  </button>
                </div>
              ))}
            </div>
            <div className="scene-detail-tag-input">
              <input
                type="text"
                placeholder="VD: Nhân vật chính bị thương..."
                value={form.must_happen_input}
                onChange={e => setForm(f => ({ ...f, must_happen_input: e.target.value }))}
                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addMustHappen(); } }}
              />
              <button className="btn btn-ghost btn-sm" onClick={addMustHappen}>
                <Plus size={12} /> Thêm
              </button>
            </div>
          </div>

          {/* Không được xảy ra */}
          <div className="scene-detail-field">
            <label className="scene-detail-label">
              <Trash2 size={13} />
              Không được xảy ra (must not happen)
            </label>
            <div className="scene-detail-tag-list">
              {form.must_not_happen.map((item, i) => (
                <div key={i} className="scene-detail-tag scene-detail-tag--warn">
                  <span>{item}</span>
                  <button onClick={() => removeMustNotHappen(i)} className="scene-detail-tag-remove">
                    <X size={10} />
                  </button>
                </div>
              ))}
            </div>
            <div className="scene-detail-tag-input">
              <input
                type="text"
                placeholder="VD: Nhân vật chính không được chết..."
                value={form.must_not_happen_input}
                onChange={e => setForm(f => ({ ...f, must_not_happen_input: e.target.value }))}
                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addMustNotHappen(); } }}
              />
              <button className="btn btn-ghost btn-sm" onClick={addMustNotHappen}>
                <Plus size={12} /> Thêm
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
