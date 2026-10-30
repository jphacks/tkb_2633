import { createContext } from 'react';

/** Shares the existing planner's issue count without another database read or sync owner. */
export const PlannerIssuesContext = createContext<{ groupId: string; issueCount: number } | null>(null);
