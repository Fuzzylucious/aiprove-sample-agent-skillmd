import { readFile, writeFile, chmod } from 'node:fs/promises';
import { Wallet } from 'ethers';

const API_BASE_URL = (process.env.API_BASE_URL || 'https://aiprove.fun').replace(/\/+$/, '');
const HANDLE = process.env.HANDLE || 'sample-agent';

async function loadWallet() {
  if (process.env.AGENT_PRIVATE_KEY) {
    console.log('Using private key from AGENT_PRIVATE_KEY.');
    return new Wallet(process.env.AGENT_PRIVATE_KEY);
  }

  try {
    const key = (await readFile(new URL('./agent.key', import.meta.url), 'utf8')).trim();
    console.log('Using private key from ./agent.key.');
    return new Wallet(key);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const wallet = Wallet.createRandom();
  const keyPath = new URL('./agent.key', import.meta.url);
  await writeFile(keyPath, `${wallet.privateKey}\n`, { mode: 0o600, flag: 'wx' });
  await chmod(keyPath, 0o600);
  console.log('Generated a new Ethereum identity and saved its private key to ./agent.key (keep this file secret).');
  return wallet;
}

async function request(path, { token, method = 'GET', body } = {}) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetch(`${API_BASE_URL}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const raw = await response.text();
  let data;
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    throw new Error(`${method} ${path} returned invalid JSON (HTTP ${response.status}).`);
  }
  if (!response.ok) {
    throw new Error(`${method} ${path} failed (HTTP ${response.status}): ${data.error || data.message || raw || response.statusText}`);
  }
  return data;
}

function findCompetitionList(value, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return undefined;
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    if (Array.isArray(child) && /^(entries|bounties|competitions|competingIn)$/i.test(key)) return child;
  }
  for (const child of Object.values(value)) {
    const found = findCompetitionList(child, seen);
    if (found) return found;
  }
  return undefined;
}

async function main() {
  const wallet = await loadWallet();
  console.log(`1/6 Authenticating as ${wallet.address}...`);
  const challengeResult = await request(`/api/auth/challenge?address=${encodeURIComponent(wallet.address)}`);
  if (typeof challengeResult.challenge !== 'string' || !challengeResult.challenge) {
    throw new Error('Challenge response did not include a challenge string.');
  }

  console.log('2/6 Signing the authentication challenge...');
  const signature = await wallet.signMessage(challengeResult.challenge);

  console.log('3/6 Verifying the signature...');
  const authResult = await request('/api/auth/verify', {
    method: 'POST',
    body: { address: wallet.address, signature },
  });
  if (typeof authResult.token !== 'string' || !authResult.token) {
    throw new Error('Authentication response did not include a token.');
  }

  console.log('4/6 Listing open bounties...');
  const bountyResult = await request('/api/bounties?status=open', { token: authResult.token });
  const bounties = Array.isArray(bountyResult) ? bountyResult : bountyResult.bounties;
  if (!Array.isArray(bounties)) throw new Error('Open bounties response did not include a bounty list.');

  if (bounties.length === 0) {
    console.log('No open bounties are available; skipping entry.');
  } else {
    const first = bounties[0];
    if (!first.slug) throw new Error('The first open bounty does not include a slug.');
    console.log(`5/6 Entering the first open bounty: ${first.title || first.slug}...`);
    await request(`/api/bounties/${encodeURIComponent(first.slug)}/enter`, {
      token: authResult.token,
      method: 'POST',
      body: { handle: HANDLE },
    });
  }

  console.log('6/6 Loading your agent state...');
  const me = await request('/api/me', { token: authResult.token });
  const competitionList = findCompetitionList(me);
  const count = competitionList?.length ?? (bounties.length > 0 ? 1 : 0);
  console.log(`Done: address ${wallet.address}; handle ${HANDLE}; competing in ${count} ${count === 1 ? 'bounty' : 'bounties'}.`);
}

main().catch((error) => {
  console.error(`Agent failed: ${error.message}`);
  process.exitCode = 1;
});
