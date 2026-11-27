export type Category =
  | "contact"
  | "identity"
  | "secret"
  | "private"
  | "unknown";
export type Rect = { x: number; y: number; width: number; height: number };
export type Identity = {
  tabId: number;
  windowId: number;
  documentId: string;
  origin: string;
  generation: number;
  urlKey: string;
  viewport: {
    width: number;
    height: number;
    scrollX: number;
    scrollY: number;
    dpr: number;
  };
  zoom: number;
};
export type Field = {
  key: string;
  kind: string;
  category: Category;
  value: string;
  rect: Rect;
  label: string;
};
export type TextBlock = {
  id: string;
  text: string;
  rects: Rect[];
  excluded: boolean;
  context: string;
};
export type Observation = {
  identity: Identity;
  capturedAt: number;
  image: string;
  text: string;
  fields: Field[];
  masks: Rect[];
  unsupported: string[];
  privateValues?: string[];
  blocks?: TextBlock[];
  protectedMasks?: Rect[];
};
export interface BrowserPort {
  capture(tabId: number, exclusions: string[]): Promise<Observation>;
  current(tabId: number): Promise<Identity>;
  insert(identity: Identity, fieldKey: string, value: string): Promise<boolean>;
  insertBatch?(
    identity: Identity,
    insertions: { fieldKey: string; value: string }[],
  ): Promise<boolean>;
}
export type SafeErrorCode =
  | "CAPTURE_FAILED"
  | "STALE_CAPTURE"
  | "POLICY_DENIED"
  | "INVALID_ARTIFACT"
  | "TOKEN_DENIED"
  | "MODEL_FAILED"
  | "INSERT_FAILED"
  | "TASK_PAUSED"
  | "UNSUPPORTED"
  | "INVALID_INPUT";
export class SafeError extends Error {
  constructor(public code: SafeErrorCode) {
    super(code);
  }
}
export function sameIdentity(a: Identity, b: Identity): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
