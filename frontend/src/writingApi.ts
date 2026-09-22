import { api } from "./api";
import type { WritingSave, WritingState } from "./writingDrafts";
const base = (projectId: string) => `/projects/${projectId}/planning/writing`;
export const loadWriting = (projectId: string) =>
  api<WritingState>(base(projectId));
export const saveWriting = (projectId: string, body: WritingSave) =>
  api<WritingState>(base(projectId), {
    method: "PUT",
    body: JSON.stringify(body),
  });
export const discardWritingCopy = (
  projectId: string,
  id: string,
  revision: number,
) =>
  api<WritingState>(`${base(projectId)}/copies/${encodeURIComponent(id)}`, {
    method: "DELETE",
    body: JSON.stringify({ baseRevision: revision }),
  });
