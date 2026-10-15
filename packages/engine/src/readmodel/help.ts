import {
  defaultConfig,
  droppedSafeguards,
  DISPLAY_STATUSES,
  LEVEL_INFO,
  LEVEL_ORDER,
  maxAgentCalls,
  rolesFor,
  ROLE_JOBS,
  ruleMarks,
  SHAPES,
  STATUSES,
  STATUS_NEXT,
  STEP_STATE_KEYS,
  STEP_STATES,
  stepsFor,
  levelNumber,
  Role,
  type HelpView,
} from '@advpipe/contracts';
import { ROLE_MODEL, ROLE_TOOLS } from '../runner/roles.js';
import { CHECKS, CHECK_HELP, ROLE_INPUTS } from './context.js';

/**
 * The Help page's data (docs/05 §5.8), built from the same tables the pipeline and the other pages
 * use (statuses, step states, roles, models, tools, levels, the default limits), so it can't drift.
 * Port of `ui/routes/help.py`.
 */
export function loadHelp(): HelpView {
  const defaults = defaultConfig();
  return {
    levels: LEVEL_ORDER.map((level) => {
      const info = LEVEL_INFO[level];
      const shape = SHAPES[level];
      const [happy, worst] = maxAgentCalls(level, defaults.limits);
      return {
        number: levelNumber(level),
        name: level,
        label: info.label,
        good_for: info.goodFor,
        description: info.description,
        agents: rolesFor(level).length,
        steps: stepsFor(level)
          .map((stage) => (stage === 'FINAL_GATES' ? 'FINAL CHECKS' : stage))
          .join(' → '),
        calls: happy === worst ? `${happy}` : `${happy} to ${worst}`,
        scan: shape.securityScan ? 'on' : 'off',
        dropped: droppedSafeguards(level, shape.securityScan),
      };
    }),
    level_labels: LEVEL_ORDER.map((level) => LEVEL_INFO[level].label),
    rule_marks: ruleMarks(),
    step_states: STEP_STATE_KEYS.map((key) => STEP_STATES[key]),
    roles: Role.options.map((role) => {
      const tools = [...ROLE_TOOLS[role]];
      return {
        role,
        job: ROLE_JOBS[role],
        inputs: ROLE_INPUTS[role],
        model: defaults.models[ROLE_MODEL[role]],
        tools,
        writes: tools.includes('Edit') || tools.includes('Write'),
      };
    }),
    checks: CHECKS.map((name) => ({ name, help: CHECK_HELP[name] ?? '' })),
    statuses: DISPLAY_STATUSES.map((key) => ({ key, ...STATUSES[key], next: STATUS_NEXT[key] })),
    limits: {
      max_rounds_spec: defaults.limits.max_rounds_spec,
      max_rounds_tests: defaults.limits.max_rounds_tests,
      max_rounds_code: defaults.limits.max_rounds_code,
      max_fix_passes: defaults.limits.max_fix_passes,
      budget_usd_per_task: defaults.limits.budget_usd_per_task,
    },
  };
}
