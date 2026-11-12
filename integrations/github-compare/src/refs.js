/**
 * Refs — decides which two versions to compare.
 *
 * Order: an explicit head, then an explicit PR, then the newest open PR,
 * then the most recently pushed branch other than the default branch.
 * An explicit base always wins; otherwise a PR's own base is used, else the
 * repository's default branch. `reason` says which rule applied, so the
 * report can show it.
 */

export class NothingToCompareError extends Error {}

/**
 * @returns {Promise<{ base: {ref, sha?}, head: {ref, sha?}, reason: string, pr?: number, defaultBranch: string }>}
 */
export async function pickRefs(source, { head, base, pr } = {}) {
  const defaultBranch = (await source.repoInfo()).default_branch;

  if (head) {
    return { head: { ref: head }, base: { ref: base || defaultBranch }, reason: 'head given', defaultBranch };
  }
  if (pr) {
    const p = await source.pullRequest(pr);
    return fromPullRequest(p, base, `PR #${p.number} given`, defaultBranch);
  }
  const newest = await source.newestOpenPullRequest();
  if (newest) {
    return fromPullRequest(newest, base, `newest open PR #${newest.number}`, defaultBranch);
  }
  const branch = await source.newestPushedBranch(defaultBranch);
  if (branch) {
    return {
      head: { ref: branch.name },
      base: { ref: base || defaultBranch },
      reason: `most recently pushed branch (${branch.how}, ${branch.when})`,
      defaultBranch,
    };
  }
  throw new NothingToCompareError('No open pull request and no branch other than the default branch. Pass --head or --pr.');
}

function fromPullRequest(p, base, reason, defaultBranch) {
  return {
    // Use the PR's head sha so PRs from forks work too.
    head: { ref: p.head.ref, sha: p.head.sha },
    base: { ref: base || p.base.ref },
    reason: `${reason}: ${p.title}`,
    pr: p.number,
    defaultBranch,
  };
}
