import { resolveEphemeralSkillsToggle } from './skills';

describe('resolveEphemeralSkillsToggle', () => {
  it('honors an explicit per-conversation choice over the config', () => {
    expect(resolveEphemeralSkillsToggle(false, { skills: { alwaysOn: true } })).toBe(false);
    expect(resolveEphemeralSkillsToggle(true, { skills: false })).toBe(true);
  });

  it('turns skills on for any model spec when interface.skills.alwaysOn is set', () => {
    expect(resolveEphemeralSkillsToggle(undefined, { skills: { alwaysOn: true } })).toBe(true);
  });

  it('stays off by default, including for boolean or missing skills config', () => {
    expect(resolveEphemeralSkillsToggle(undefined, undefined)).toBe(false);
    expect(resolveEphemeralSkillsToggle(undefined, { skills: true })).toBe(false);
    expect(resolveEphemeralSkillsToggle(undefined, { skills: { alwaysOn: false } })).toBe(false);
    expect(resolveEphemeralSkillsToggle('yes', { skills: {} })).toBe(false);
  });
});
