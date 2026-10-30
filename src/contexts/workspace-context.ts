import { createContext } from 'react';
import type { SharedWorkspace, SharingSelection } from '../platform/sharing/workspaces';
import type { SharingWorkspaceRecord } from '../platform/storage/sharing-registry';
export interface WorkspaceContextValue {
  active: SharedWorkspace | null; groups: SharingWorkspaceRecord[]; userId: string | null; ready: boolean; error: string | null;
  refreshSharing: () => Promise<void>; switchTo: (selection: SharingSelection | null) => Promise<void>;
}
export const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);
