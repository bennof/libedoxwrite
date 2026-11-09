# Publishing the GitHub repository

Use the contents of this project as the root of a new repository, not as a nested `experiment/` directory. The included CI workflow expects package.json at the repository root.

The prepared source archive excludes dependencies, build output, historical audit reports, local documents, and environment files. Extract it into a separate directory outside the original workspace before initializing Git.

```sh
npm ci
npm run check
npm test
npm run build

git init -b main
git add .
git diff --cached --stat
git commit -m "Initial release of libedoxwrite"
```

Create an empty GitHub repository, then use its actual URL:

```sh
git remote add origin <your-repository-url>
git push -u origin main
```

After the repository URL is known, add the appropriate `repository`, `bugs`, and `homepage` fields to package.json. Check the GitHub Actions results before creating a release tag. Local verification used Node.js 24; CI also checks Node.js 20 and 22.

GitHub publication and npm publication are separate. No automatic publishing workflow is configured. To inspect a potential npm release, run `npm pack --dry-run`; this runs checks, tests, and a build through `prepack`. Confirm the package name and release version before any npm publication.
