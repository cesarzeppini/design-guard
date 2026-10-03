export type ComponentStatus = 'approved' | 'approved-unused' | 'unmarked-in-use' | 'unmarked-unused';

export interface ComponentInfo {
  key: string;
  name: string;
  file: string;
  dir: string;
  approved: boolean;
  unstyledByDesign: boolean;
  usageCount: number;
  usedBy: string[];
  status: ComponentStatus;
  props: { name: string; optional: boolean; type: string }[];
  variants: Record<string, string[]>;
}

export interface Summary {
  total: number;
  approved: number;
  approvedUnused: number;
  decisionsWaiting: number;
  unused: number;
  approvedUsage: number;
  totalUsage: number;
  adoption: number | null;
  rawElements: number;
  rawElementFiles: number;
}

export function scanProject(opts: { files: Record<string, string>; componentDirs: string[] }): ComponentInfo[];
export function summarize(
  components: ComponentInfo[],
  opts?: { files?: Record<string, string>; componentDirs?: string[]; exclude?: string[] },
): Summary;
