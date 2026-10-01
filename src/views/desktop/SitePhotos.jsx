// Site Photos module — gallery of project-tagged images uploaded by field
// staff, with approval workflow.

import React, { useMemo, useState } from 'react';
import {
  Camera,
  CheckCircle2,
  Filter,
  ImagePlus,
  MapPin,
  Search,
  Tag,
  UploadCloud,
  X,
} from 'lucide-react';
import { useStore } from '../../state/store.jsx';
import { filterByScope } from '../../data/permissions.js';
import {
  Avatar,
  Badge,
  Button,
  EmptyState,
  Field,
  Modal,
  Panel,
  Select,
  StatTile,
  TextInput,
  timeAgo,
} from '../../components/ui.jsx';
import { Can } from '../../components/Can.jsx';

const CATEGORIES = ['Progress', 'Amenities', 'Inventory', 'Handover', 'Marketing'];

export function SitePhotos() {
  const { state, currentUser, actions } = useStore();
  const photos = useMemo(
    () => filterByScope(currentUser, 'photos', 'view', state.photos),
    [currentUser, state.photos]
  );
  const [projectFilter, setProjectFilter] = useState('all');
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [approvedFilter, setApprovedFilter] = useState('all');
  const [query, setQuery] = useState('');
  const [uploading, setUploading] = useState(false);

  const filtered = useMemo(() => {
    return photos.filter((photo) => {
      if (projectFilter !== 'all' && photo.projectId !== projectFilter) return false;
      if (categoryFilter !== 'all' && photo.category !== categoryFilter) return false;
      if (approvedFilter === 'approved' && !photo.approved) return false;
      if (approvedFilter === 'pending' && photo.approved) return false;
      if (!query) return true;
      return photo.caption.toLowerCase().includes(query.toLowerCase());
    });
  }, [photos, projectFilter, categoryFilter, approvedFilter, query]);

  const projectCounts = useMemo(() => {
    const map = {};
    photos.forEach((p) => {
      map[p.projectId] = (map[p.projectId] || 0) + 1;
    });
    return map;
  }, [photos]);

  return (
    <div className="photos-page">
      <section className="stat-grid">
        <StatTile label="Total photos" value={photos.length} tone="info" icon={ImagePlus} />
        <StatTile label="Approved" value={photos.filter((p) => p.approved).length} tone="success" icon={CheckCircle2} />
        <StatTile label="Pending review" value={photos.filter((p) => !p.approved).length} tone="warning" icon={UploadCloud} />
        <StatTile label="Projects covered" value={Object.keys(projectCounts).length} tone="premium" icon={Tag} />
      </section>

      <Panel
        title="Site Photo Library"
        subtitle={`${filtered.length} photos in your scope`}
        icon={Camera}
        action={
          <Can resource="photos" action="create">
            <Button variant="primary" icon={ImagePlus} onClick={() => setUploading(true)}>
              Upload photo
            </Button>
          </Can>
        }
      >
        <div className="filter-bar">
          <TextInput
            icon={Search}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by caption"
          />
          <Select value={projectFilter} onChange={(e) => setProjectFilter(e.target.value)}>
            <option value="all">All projects</option>
            {state.projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
          <Select value={categoryFilter} onChange={(e) => setCategoryFilter(e.target.value)}>
            <option value="all">All categories</option>
            {CATEGORIES.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </Select>
          <Select value={approvedFilter} onChange={(e) => setApprovedFilter(e.target.value)}>
            <option value="all">All</option>
            <option value="approved">Approved</option>
            <option value="pending">Pending review</option>
          </Select>
        </div>

        {filtered.length === 0 ? (
          <EmptyState
            icon={Camera}
            title="No photos match"
            description="Try clearing filters or upload your first site photo."
          />
        ) : (
          <div className="photo-grid">
            {filtered.map((photo) => {
              const project = state.projects.find((p) => p.id === photo.projectId);
              const uploader = state.users.find((u) => u.id === photo.staffId);
              return (
                <article className="photo-card" key={photo.id}>
                  <img src={photo.url} alt={photo.caption} />
                  <div className="photo-card-body">
                    <header>
                      <strong>{project?.name}</strong>
                      <Badge tone={photo.approved ? 'success' : 'warning'} size="sm">
                        {photo.approved ? 'Approved' : 'Pending'}
                      </Badge>
                    </header>
                    <p>{photo.caption}</p>
                    <ul className="kv-list kv-list-tight">
                      <li><span>Category</span><strong>{photo.category}</strong></li>
                      <li><span>Uploaded by</span><strong>{uploader?.name || '—'}</strong></li>
                      <li><span>Uploaded</span><strong>{timeAgo(photo.uploadedAt)}</strong></li>
                    </ul>
                    {photo.geo && (
                      <a
                        className="photo-geo"
                        href={`https://maps.google.com/?q=${photo.geo.lat},${photo.geo.lng}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        <MapPin size={12} /> {photo.geo.lat.toFixed(4)}, {photo.geo.lng.toFixed(4)}
                      </a>
                    )}
                    <footer>
                      {!photo.approved && (
                        <Can resource="photos" action="approve">
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => actions.approvePhoto(photo.id, true)}
                          >
                            Approve
                          </Button>
                        </Can>
                      )}
                      <Can resource="photos" action="delete">
                        <Button size="sm" variant="ghost">Remove</Button>
                      </Can>
                    </footer>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </Panel>

      {uploading && <UploadModal onClose={() => setUploading(false)} />}
    </div>
  );
}

function UploadModal({ onClose }) {
  const { actions, state, currentUser } = useStore();
  const [projectId, setProjectId] = useState(state.projects[0]?.id || '');
  const [category, setCategory] = useState('Progress');
  const [caption, setCaption] = useState('');
  const [files, setFiles] = useState([]);

  const submit = () => {
    if (files.length === 0) {
      actions.toast('Pick at least one file.', 'error');
      return;
    }
    let added = 0;
    files.forEach((file) => {
      // Use existing seed images as the upload URL so the demo always shows something.
      const fallbackUrl = state.projects.find((p) => p.id === projectId)?.image;
      const photo = {
        projectId,
        category,
        caption: caption || file.name,
        url: file.url || fallbackUrl,
        geo: { lat: 12.97, lng: 77.59 },
      };
      actions.addPhoto(photo);
      added += 1;
    });
    actions.toast(`${added} photo${added === 1 ? '' : 's'} uploaded.`, 'success');
    onClose();
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Upload site photos"
      width={620}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={submit}>Upload</Button>
        </>
      }
    >
      <div className="grid-2">
        <Field label="Project" required>
          <Select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            {state.projects.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </Select>
        </Field>
        <Field label="Category" required>
          <Select value={category} onChange={(e) => setCategory(e.target.value)}>
            {CATEGORIES.map((c) => <option key={c}>{c}</option>)}
          </Select>
        </Field>
        <Field label="Caption" span={2}>
          <TextInput value={caption} onChange={(e) => setCaption(e.target.value)} placeholder="What's in this photo?" />
        </Field>
        <Field label="Photos" span={2} required>
          <label className="upload-zone">
            <input
              type="file"
              accept="image/*"
              multiple
              onChange={(e) => {
                const list = Array.from(e.target.files || []);
                setFiles(list.map((f) => ({ name: f.name, url: URL.createObjectURL(f) })));
              }}
            />
            <UploadCloud size={26} />
            <strong>Click to upload</strong>
            <span>{files.length === 0 ? 'JPG, PNG up to 10 MB' : `${files.length} file${files.length === 1 ? '' : 's'} ready`}</span>
          </label>
        </Field>
      </div>
    </Modal>
  );
}
