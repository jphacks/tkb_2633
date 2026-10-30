export interface CompletionFeedback {
  values: ReadonlyMap<string, boolean>;
  run(key: string, completed: boolean, work: () => Promise<unknown>): Promise<void>;
}
