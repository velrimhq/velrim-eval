# Salt reveal

The split manifests in `results/manifests/` were frozen on 2026-06-24, before this comparison was
designed. Each one lists the held-out (`cal-test`) documents as salted hashes, so the held-out set
was committed without revealing it, and carries `saltCommitment = sha256(salt)` so the salt could
be revealed later and checked. This is that reveal.

```
salt            f5143262a527efd985442ea7ec9c658e
saltCommitment  883d44e1cb60ee3b1feecaffcdba377c7146ba63d8c4306b9c1be3207aed31b7
scheme          sha256(salt || ':' || class || ':' || docId)      docId = the file name without .pdf
```

## Check it yourself

Every document in `corpora/golden.<class>.jsonl` must hash into that class's `cal-test` id list,
and `sha256(salt)` must equal the commitment in every manifest. No keys, no network:

```js
// node check-salt.mjs
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
const salt = 'f5143262a527efd985442ea7ec9c658e';
const sha = (s) => createHash('sha256').update(s).digest('hex');
for (const cls of ['cord-v2', 'deepform', 'vrdu-ad-buy', 'vrdu-registration']) {
  const m = JSON.parse(readFileSync(`results/manifests/${cls}.manifest.json`, 'utf8'));
  const ids = new Set(m.splits['cal-test'].ids);
  const docs = readFileSync(`corpora/golden.${cls}.jsonl`, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l).doc.replace(/\.pdf$/, ''));
  const hits = docs.filter((d) => ids.has(sha(`${salt}:${cls}:${d}`))).length;
  console.log(
    cls,
    `commitment ${sha(salt) === m.saltCommitment ? 'ok' : 'MISMATCH'}`,
    `${hits}/${docs.length} documents in cal-test`,
  );
}
```

Expected: `commitment ok` and every document matched, for all four classes (15, 39, 22, 48).
`test/salt.test.ts` runs the same check in CI.
