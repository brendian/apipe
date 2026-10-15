import { readFileSync } from 'node:fs';
import { parseWorkItem, WorkItemError, type WorkItem } from '@advpipe/contracts';

/** Read and parse a work-item file. Errors name the file (and the line, for front matter). */
export function loadWorkItem(file: string): WorkItem {
  let text: string;
  try {
    text = readFileSync(file, { encoding: 'utf-8', flag: 'r' });
  } catch (e) {
    throw new WorkItemError(`can't read work item ${file}: ${e instanceof Error ? e.message : e}`);
  }
  return parseWorkItem(text, file);
}
