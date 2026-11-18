export type ComponentStatus = 'approved' | 'approved-unused' | 'unmarked-in-use' | 'unmarked-unused' | 'deprecated';

export interface ComponentInfo {
  key: string;
  name: string;
  file: string;
  dir: string;
  approved: boolean;
  unstyledByDesign: boolean;
  deprecated: boolean;
  /** Named in the marker (`@deprecated → NewCard`), when given. */
  replacement: string | null;
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
  deprecated: number;
  decisionsWaiting: number;
  unused: number;
  approvedUsage: number;
  totalUsage: number;
  adoption: number | null;
  rawElements: number;
  rawElementFiles: number;
}

export function deprecationOf(text: string): { replacement: string | null } | null;
export function resolveImportKey(fromFile: string, spec: string, componentDirs: string[]): string | null;
export function scanProject(opts: { files: Record<string, string>; componentDirs: string[] }): ComponentInfo[];
export function summarize(
  components: ComponentInfo[],
  opts?: { files?: Record<string, string>; componentDirs?: string[]; exclude?: string[] },
): Summary;
