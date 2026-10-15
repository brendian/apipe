import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { BypassAnswers, SCHEMA_NAMES, type OpenQuestion, type Role } from '@advpipe/contracts';
import { MAX_ANSWER_CHARS, MAX_REASONING_CHARS } from '../core/answers.js';
import { callJsonAgent } from './calls.js';
import type { Context } from './context.js';
import { bypassPrompt, FALLBACK_ANSWER, FALLBACK_REASON } from './prompts.js';
import { taskMdPath } from './guards.js';

/**
 * The person chose Bypass for `questions`: ask `role` (the agent that asked them) for its own
 * answers, once, and record them with `source: 'agent'` (docs/02 §5.2).
 *
 * One JSON call, retried once on bad JSON. Whatever files the call changed are put back, and
 * task.md is restored byte for byte. A question the agent leaves unanswered gets a stand-in answer,
 * so the run can't stall. The reply is saved to `relPath` in the run directory and is never shown
 * to later agents: they see only the Answers section of task.md.
 */
export async function bypassQuestions(
  ctx: Context,
  role: Role,
  questions: readonly OpenQuestion[],
  previousTaskMd: string,
  stage: string,
  relPath: string,
): Promise<void> {
  if (questions.length === 0) return;
  const { state, workspace: ws } = ctx;
  const taskPath = taskMdPath(ctx);
  const before = existsSync(taskPath) ? readFileSync(taskPath) : null;
  const ids = questions.map((q) => q.id);
  ctx.emit('round', `the agent decides ${ids.join(', ')} itself (Bypass)`);
  const prompt = bypassPrompt(state.work_item, previousTaskMd, questions);
  const cutOff = ctx.cutOff;
  ctx.cutOff = false; // this call mustn't carry on partial work
  let parsed: BypassAnswers | null;
  let raw: string;
  try {
    ({ parsed, raw } = await callJsonAgent(
      ctx,
      role,
      prompt,
      stage,
      BypassAnswers,
      SCHEMA_NAMES.bypass,
    ));
  } finally {
    ctx.cutOff = cutOff;
  }
  const stray = (await ws.changedFiles(state.base_commit)).filter((f) => f !== 'task.md');
  if (stray.length > 0) {
    await ws.restore(state.base_commit, stray);
    state.notes.push(
      `${role} edited files while answering its own questions; reverted: ${stray.join(', ')}`,
    );
  }
  if (before === null) {
    if (existsSync(taskPath)) unlinkSync(taskPath);
  } else {
    writeFileSync(taskPath, before);
  }
  const given = new Map((parsed?.answers ?? []).map((a) => [a.id.trim().toUpperCase(), a]));
  const now = new Date().toISOString();
  const fallback: string[] = [];
  for (const q of questions) {
    const a = given.get(q.id);
    const text = a?.answer.trim() ?? '';
    if (a !== undefined && text !== '') {
      q.answer = text.slice(0, MAX_ANSWER_CHARS);
      q.reasoning = a.reasoning.trim().slice(0, MAX_REASONING_CHARS);
    } else {
      q.answer = FALLBACK_ANSWER;
      q.reasoning = FALLBACK_REASON;
      fallback.push(q.id);
    }
    q.source = 'agent';
    q.answered_at = now;
    q.applied = false;
  }
  if (fallback.length > 0) {
    state.notes.push(
      `${role} gave no usable answer to ${fallback.join(', ')} under Bypass; ` +
        'a stand-in answer was recorded.',
    );
  }
  ctx.runlog.writeJson(relPath, {
    asked: ids,
    answers: questions.map((q) => ({
      id: q.id,
      answer: q.answer,
      reasoning: q.reasoning,
      stand_in: fallback.includes(q.id),
    })),
    reply: raw,
  });
  ctx.save();
  ctx.emit('answers', `${role} answered ${ids.join(', ')} with its best judgement (Bypass)`, {
    ids,
    agent: true,
  });
}
