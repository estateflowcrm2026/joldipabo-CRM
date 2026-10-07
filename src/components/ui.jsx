// Reusable UI primitives. All components in this file are presentational only —
// none of them encode role logic. Permission decisions live in `<Can>`.

import React, { useEffect, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Inbox,
  Lock,
  Loader2,
  X,
} from 'lucide-react';
import { useStore } from '../state/store.jsx';

// ----- Avatar ----------------------------------------------------------------

export function Avatar({ name, size = 'md', tone = 'dark' }) {
  const initials = (name || '?')
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase();
  return (
    <span className={`avatar avatar-${size} avatar-${tone}`} aria-hidden="true">
      {initials}
    </span>
  );
}

// ----- Badge -----------------------------------------------------------------

export function Badge({ children, tone = 'neutral', size = 'md', dot = false }) {
  return (
    <span className={`badge badge-${tone} badge-${size}`}>
      {dot && <span className="badge-dot" />}
      {children}
    </span>
  );
}

// ----- Card / Panel / Section ------------------------------------------------

export function Panel({
  title,
  icon: Icon,
  subtitle,
  action,
  children,
  padded = true,
  className = '',
}) {
  return (
    <section className={`panel ${padded ? 'panel-padded' : ''} ${className}`}>
      {(title || action) && (
        <header className="panel-header">
          <div className="panel-header-title">
            {Icon && (
              <span className="panel-icon">
                <Icon size={18} />
              </span>
            )}
            <div>
              <h3>{title}</h3>
              {subtitle && <span className="panel-subtitle">{subtitle}</span>}
            </div>
          </div>
          {action && <div className="panel-action">{action}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

// ----- Buttons ---------------------------------------------------------------

export function Button({
  children,
  variant = 'primary',
  size = 'md',
  icon: Icon,
  iconEnd,
  block = false,
  ...rest
}) {
  const classes = [
    'btn',
    `btn-${variant}`,
    `btn-${size}`,
    block ? 'btn-block' : '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <button className={classes} {...rest}>
      {Icon && <Icon size={size === 'sm' ? 14 : 16} />}
      <span>{children}</span>
      {iconEnd && <iconEnd size={size === 'sm' ? 14 : 16} />}
    </button>
  );
}

// ----- Inputs ----------------------------------------------------------------

export function Field({ label, hint, children, required = false, span = 1 }) {
  return (
    <label className={`field field-span-${span}`}>
      {label && (
        <span className="field-label">
          {label}
          {required && <em className="field-required">*</em>}
        </span>
      )}
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

export function TextInput({ icon: Icon, ...rest }) {
  if (Icon) {
    return (
      <span className="text-input">
        <Icon size={16} />
        <input {...rest} />
      </span>
    );
  }
  return <input className="text-input-plain" {...rest} />;
}

export function Select({ icon: Icon, children, ...rest }) {
  return (
    <span className="text-input">
      {Icon && <Icon size={16} />}
      <select className="text-input-select" {...rest}>
        {children}
      </select>
    </span>
  );
}

// ----- Empty state -----------------------------------------------------------

export function EmptyState({
  icon: Icon = Inbox,
  title,
  description,
  action,
}) {
  return (
    <div className="empty-state">
      <span className="empty-icon">
        <Icon size={22} />
      </span>
      <strong>{title}</strong>
      {description && <p>{description}</p>}
      {action}
    </div>
  );
}

// ----- Loading state ---------------------------------------------------------

export function LoadingState({ label = 'Loading' }) {
  return (
    <div className="loading-state">
      <Loader2 size={18} className="spin" />
      <span>{label}…</span>
    </div>
  );
}

// ----- Restricted state ------------------------------------------------------

export function RestrictedState({ resource, action, scope, role, onRequest }) {
  return (
    <div className="restricted-state">
      <span className="restricted-icon">
        <Lock size={20} />
      </span>
      <strong>Restricted access</strong>
      <p>
        Your role <em>{role}</em> cannot {action} {resource} at scope <em>{scope}</em>.
      </p>
      {onRequest && (
        <button className="btn btn-secondary btn-sm" onClick={onRequest}>
          Request access
        </button>
      )}
    </div>
  );
}

// ----- Modal -----------------------------------------------------------------

export function Modal({ open, onClose, title, children, footer, width = 560 }) {
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => e.key === 'Escape' && onClose?.();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label={title} onClick={onClose}>
      <div
        className="modal"
        style={{ maxWidth: width }}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="modal-header">
          <h3>{title}</h3>
          <button className="btn-icon" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-footer">{footer}</footer>}
      </div>
    </div>
  );
}

// ----- Toast host ------------------------------------------------------------

export function ToastHost() {
  const { state, actions } = useStore();
  if (!state.toasts?.length) return null;
  return (
    <div className="toast-host" aria-live="polite">
      {state.toasts.map((toast) => (
        <div className={`toast toast-${toast.tone}`} key={toast.id}>
          {toast.tone === 'error' ? <AlertCircle size={16} /> : <CheckCircle2 size={16} />}
          <span>{toast.message}</span>
          <button
            className="btn-icon"
            onClick={() => actions.dismissToast?.(toast.id) || null}
            aria-label="Dismiss"
          >
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}

// ----- Drawer (slide-up sheet for mobile) -----------------------------------

export function Drawer({ open, onClose, title, children, footer }) {
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => e.key === 'Escape' && onClose?.();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <div className="drawer" onClick={(e) => e.stopPropagation()}>
        <span className="drawer-handle" />
        <header className="drawer-header">
          <h3>{title}</h3>
          <button className="btn-icon" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </header>
        <div className="drawer-body">{children}</div>
        {footer && <footer className="drawer-footer">{footer}</footer>}
      </div>
    </div>
  );
}

// ----- Stat tile -------------------------------------------------------------

export function StatTile({ label, value, delta, tone = 'neutral', icon: Icon }) {
  return (
    <article className={`stat-tile stat-${tone}`}>
      <header>
        <span>{label}</span>
        {Icon && (
          <span className="stat-icon">
            <Icon size={16} />
          </span>
        )}
      </header>
      <strong>{value}</strong>
      {delta && <small>{delta}</small>}
    </article>
  );
}

// ----- Section header --------------------------------------------------------

export function SectionTitle({ eyebrow, title, action }) {
  return (
    <header className="section-title">
      <div>
        {eyebrow && <span className="section-eyebrow">{eyebrow}</span>}
        <h2>{title}</h2>
      </div>
      {action}
    </header>
  );
}

// ----- Helper: copy-to-clipboard + tel/wa links -----------------------------

export function buildTelLink(phone) {
  return `tel:${(phone || '').replace(/[^0-9+]/g, '')}`;
}

export function buildWhatsAppLink(phone, text = '') {
  const cleaned = (phone || '').replace(/[^0-9]/g, '');
  return `https://wa.me/${cleaned}${text ? `?text=${encodeURIComponent(text)}` : ''}`;
}

// ----- Currency helper -------------------------------------------------------

export function formatINR(amount) {
  if (amount == null) return '—';
  if (amount >= 10000000) return `₹ ${(amount / 10000000).toFixed(2)} Cr`;
  if (amount >= 100000) return `₹ ${(amount / 100000).toFixed(2)} L`;
  return `₹ ${amount.toLocaleString('en-IN')}`;
}

export function timeAgo(iso) {
  if (!iso) return '';
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.round(ms / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return `${days} d ago`;
}

export function formatTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
}

export function formatDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

export function formatDateTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

// ----- Toggle ---------------------------------------------------------------

export function Toggle({ checked, onChange, label }) {
  const [local, setLocal] = useState(Boolean(checked));
  useEffect(() => setLocal(Boolean(checked)), [checked]);
  return (
    <label className="toggle">
      <button
        type="button"
        className={`toggle-track ${local ? 'on' : ''}`}
        onClick={() => {
          setLocal(!local);
          onChange?.(!local);
        }}
        aria-pressed={local}
      >
        <span className="toggle-thumb" />
      </button>
      {label && <span>{label}</span>}
    </label>
  );
}
