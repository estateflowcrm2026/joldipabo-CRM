// Communication Hub — threaded inbox across the org. Threads are scoped
// to participants the user can read; the chat composer is permission-gated.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  MessageSquareText,
  Phone,
  Search,
  Send,
  Sparkles,
  Users,
} from 'lucide-react';
import { useStore } from '../../state/store.jsx';
import { filterByScope } from '../../data/permissions.js';
import {
  Avatar,
  Badge,
  Button,
  EmptyState,
  Panel,
  TextInput,
  formatDate,
  formatTime,
  timeAgo,
} from '../../components/ui.jsx';
import { Can } from '../../components/Can.jsx';

export function Comms() {
  const { state, currentUser } = useStore();
  const threads = useMemo(
    () =>
      state.threads.filter((thread) =>
        thread.participants?.includes(currentUser.id)
      ),
    [state.threads, currentUser.id]
  );

  const [activeId, setActiveId] = useState(threads[0]?.id || null);
  useEffect(() => {
    if (!activeId && threads[0]) setActiveId(threads[0].id);
  }, [threads, activeId]);
  const [query, setQuery] = useState('');

  const filteredThreads = useMemo(() => {
    const lower = query.toLowerCase();
    if (!lower) return threads;
    return threads.filter((t) => t.subject.toLowerCase().includes(lower));
  }, [threads, query]);

  const activeThread = threads.find((t) => t.id === activeId);

  return (
    <div className="comms-page">
      <Panel title="Communication Hub" subtitle="Team threads, approvals, broadcast" icon={MessageSquareText}>
        <div className="comms-shell">
          <aside className="thread-list">
            <div className="thread-search">
              <TextInput
                icon={Search}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search threads"
              />
            </div>
            {filteredThreads.length === 0 ? (
              <EmptyState title="No threads" description="Start a new conversation from a lead or staff profile." />
            ) : (
              filteredThreads.map((thread) => {
                const lastMessage = state.messages
                  .filter((m) => m.threadId === thread.id)
                  .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())[0];
                const participant = thread.participants.find((p) => p !== currentUser.id);
                const otherUser = state.users.find((u) => u.id === participant);
                return (
                  <button
                    key={thread.id}
                    className={`thread-item ${activeId === thread.id ? 'thread-item-active' : ''}`}
                    onClick={() => setActiveId(thread.id)}
                  >
                    <Avatar name={otherUser?.name || thread.subject} size="sm" />
                    <div>
                      <strong>{otherUser?.name || thread.subject}</strong>
                      <span>{lastMessage?.text?.slice(0, 80) || thread.subject}</span>
                      <small>{timeAgo(thread.lastMessageAt)}</small>
                    </div>
                    {thread.unread && <span className="dot dot-red" />}
                  </button>
                );
              })
            )}
          </aside>

          <section className="thread-view">
            {activeThread ? (
              <ThreadView thread={activeThread} />
            ) : (
              <EmptyState title="Pick a thread" icon={MessageSquareText} />
            )}
          </section>
        </div>
      </Panel>
    </div>
  );
}

function ThreadView({ thread }) {
  const { state, currentUser, actions } = useStore();
  const messages = state.messages
    .filter((m) => m.threadId === thread.id)
    .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  const [draft, setDraft] = useState('');
  const scrollRef = useRef(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages.length]);

  const participant = thread.participants.find((p) => p !== currentUser.id);
  const otherUser = state.users.find((u) => u.id === participant);

  const send = () => {
    if (!draft.trim()) return;
    actions.sendMessage({ threadId: thread.id, text: draft.trim() });
    setDraft('');
  };

  return (
    <>
      <header className="thread-header">
        <Avatar name={otherUser?.name} size="md" />
        <div>
          <strong>{otherUser?.name || thread.subject}</strong>
          <small>{otherUser?.designation} · {otherUser?.email}</small>
        </div>
        <div className="thread-actions">
          <a className="btn btn-icon" href={`tel:${otherUser?.phone?.replace(/\s/g, '')}`} aria-label="Call">
            <Phone size={16} />
          </a>
          <Can resource="communications" action="create">
            <Button size="sm" variant="secondary" icon={Sparkles}>Suggest reply</Button>
          </Can>
        </div>
      </header>

      <div className="thread-messages" ref={scrollRef}>
        {messages.map((message, idx) => {
          const fromUser = state.users.find((u) => u.id === message.fromId);
          const mine = message.fromId === currentUser.id;
          const prev = messages[idx - 1];
          const sameAuthor = prev && prev.fromId === message.fromId;
          return (
            <div key={message.id} className={`message-bubble ${mine ? 'mine' : 'theirs'} ${sameAuthor ? 'message-same' : ''}`}>
              {!sameAuthor && (
                <Avatar name={fromUser?.name} size="sm" tone={mine ? 'dark' : 'light'} />
              )}
              <div className="message-bubble-body">
                {!sameAuthor && <strong>{fromUser?.name}</strong>}
                <p>{message.text}</p>
                <small>{formatTime(message.timestamp)}</small>
              </div>
            </div>
          );
        })}
      </div>

      <Can
        resource="communications"
        action="create"
        fallback={
          <div className="thread-composer thread-composer-locked">
            <Badge tone="warning" size="sm">Read-only</Badge>
            <span>Your role cannot send messages in this thread.</span>
          </div>
        }
      >
        <div className="thread-composer">
          <TextInput
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            placeholder={`Message ${otherUser?.name || 'the team'}…`}
          />
          <Button variant="primary" icon={Send} onClick={send}>
            Send
          </Button>
        </div>
      </Can>
    </>
  );
}
