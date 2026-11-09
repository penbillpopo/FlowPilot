import { describe, expect, it } from 'vitest';
import { mergeDecision, type PolicyState } from '../src/main/azure';

const ME = 'me-id';
const group = { id: 'g', displayName: '[Platform Frontend]\\Frontend Reviewer', uniqueName: 'vstfs:///x', isContainer: true, isRequired: true, vote: 0 };
const pr = (over: Record<string, unknown> = {}) => ({ pullRequestId: 1, title: 'x', targetRefName: 'refs/heads/dev', status: 'active', mergeStatus: 'succeeded', reviewers: [group], ...over });
const review = (status: string): PolicyState => ({ name: 'Required reviewers', status, blocking: true });
const prod = ['version/0.0.1'];

describe('能不能在 FlowPilot 完成合併', () => {
  it('正式環境分支不行；設定檔沒寫正式環境分支也不行', () => {
    expect(mergeDecision(pr({ targetRefName: 'refs/heads/version/0.0.1' }), [], ME, prod)).toMatchObject({ canMerge: false, reason: expect.stringContaining('正式環境') });
    expect(mergeDecision(pr(), [], ME, undefined)).toMatchObject({ canMerge: false, reason: expect.stringContaining('prodBranches') });
  });

  it('有選其他審核人不行；自動加的必要群組和你自己不算', () => {
    const mcl = { id: 'mcl', displayName: 'mcl', uniqueName: 'mcl@x.com', vote: 0 };
    expect(mergeDecision(pr({ reviewers: [group, mcl] }), [], ME, prod)).toMatchObject({ canMerge: false, reason: expect.stringContaining('mcl@x.com') });
    // 自己選的群組（不是必要的）也算別人
    expect(mergeDecision(pr({ reviewers: [{ ...group, isRequired: false }] }), [], ME, prod).canMerge).toBe(false);
    const me = { id: ME, displayName: 'ban', uniqueName: 'ban@x.com', vote: 10 };
    expect(mergeDecision(pr({ reviewers: [group, me] }), [review('approved')], ME, prod)).toEqual({ canMerge: true, needApprove: false, reason: '' });
  });

  it('只差審核規則：可以，要先核准；你已經核准了還沒通過就等', () => {
    expect(mergeDecision(pr(), [review('queued')], ME, prod)).toEqual({ canMerge: true, needApprove: true, reason: '' });
    const me = { id: ME, displayName: 'ban', uniqueName: 'ban@x.com', vote: 10 };
    expect(mergeDecision(pr({ reviewers: [group, me] }), [review('queued')], ME, prod)).toMatchObject({ canMerge: false, approvedPending: true });
  });

  it('有衝突、還在試合併、你投了拒絕、其他規則沒過：不行', () => {
    expect(mergeDecision(pr({ mergeStatus: 'conflicts' }), [], ME, prod).canMerge).toBe(false);
    expect(mergeDecision(pr({ mergeStatus: 'queued' }), [], ME, prod).canMerge).toBe(false);
    expect(mergeDecision(pr({ reviewers: [group, { id: ME, displayName: 'ban', uniqueName: 'ban@x.com', vote: -10 }] }), [], ME, prod).canMerge).toBe(false);
    expect(mergeDecision(pr(), [{ name: 'Build', status: 'rejected', blocking: true }], ME, prod)).toMatchObject({ canMerge: false, reason: expect.stringContaining('Build') });
    // 不是必要的規則沒過不擋
    expect(mergeDecision(pr(), [{ name: 'Build', status: 'rejected', blocking: false }], ME, prod).canMerge).toBe(true);
    expect(mergeDecision(pr({ status: 'completed' }), [], ME, prod).canMerge).toBe(false);
  });
});
