# Publishing the dataset to Hugging Face

The files under `data/` are derived from `results/` and `corpora/` by `npm run hf-dataset`, and `npm test` fails when they drift. Publishing is a manual step, done from the maintainers' account `hello@velrim.com`. Never from a personal account.

## Before uploading

1. Regenerate and check the tree. Both must be clean.

   ```sh
   npm run hf-dataset
   npm test
   git status --short hf-dataset
   ```

   The generator refuses to write when any output byte matches a sweep pattern. Maintainers pass their extra denylist with `node dist/hf-dataset-cli.js --denylist <file>`.

2. Read `README.md` in this directory once more. It is the dataset card. Every number in it must match `BAKE-OFF.md`.

## Upload

```sh
pip install -U "huggingface_hub[cli]"
huggingface-cli login            # the hello@velrim.com account, a write token
huggingface-cli whoami           # must print the Velrim account or org

# create the dataset repo (pick the org or account name once, keep it)
huggingface-cli repo create fabrication-on-absent-fields --type dataset --organization velrim

# upload the card and the data files, nothing else
huggingface-cli upload velrim/fabrication-on-absent-fields hf-dataset . \
  --repo-type dataset \
  --exclude "publish.md" \
  --commit-message "round 1"
```

Newer releases of the client call the same commands `hf auth login`, `hf repo create` and `hf upload`.

## After uploading

1. Open the dataset page and check that the viewer shows the three configs (`predictions`, `probes`, `absent-label-audit`) and the front matter renders.
2. Link the dataset from `README.md` in the repository root and from the write-up's data section, in the same commit.
3. Do not enable a Hugging Face DOI. The citable record is the Zenodo DOI already in the card.
4. A later round uploads with a new commit message. Files are replaced, never left beside superseded copies.
