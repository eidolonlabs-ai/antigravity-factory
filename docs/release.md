# Plugin distribution and release

The canonical source is `plugins/agy-software-factory/`. Keep its supported manifest fields, skills, rules, hook scripts and Node libraries self-contained. Root scripts/tests/example apps are development infrastructure, not plugin runtime dependencies.

## Repository installation

```sh
git clone https://github.com/theRealMarkCastillo/agy-software-factory.git
cd agy-software-factory
agy plugin validate ./plugins/agy-software-factory --strict
agy plugin install ./plugins/agy-software-factory
agy plugin list
```

Use a reviewed tag when consuming a release. Native installation affects the user's Antigravity profile; this project does not install itself during tests. Alternatively use workspace `init --mode copy` or development `--mode link`. Do not register both routes unintentionally. Direct GitHub installation of this nested repository remains unqualified; do not advertise guessed tree/subdirectory URL syntax.

## Build and qualify

```sh
npm test
node bin/agy-factory.js verify --require-tests
node bin/agy-factory.js audit-diff
npm run package:plugin
node scripts/smoke-plugin.js dist/agy-software-factory-1.1.0.tgz --native
```

The build emits a versioned tar archive and a SHA-256 inventory under `dist/`. The smoke test extracts into a temporary path with spaces, makes the bundle read-only, initializes a disposable project, and runs the packaged CLI and hooks. `--native` additionally requires strict Antigravity validation; missing `agy` fails this qualification. Portable CI without `agy` does not claim native qualification. Checksums permit comparison, not publisher authentication. Only inspect/extract trusted release archives.

The release-candidate workflow builds and uploads CI artifacts with read-only repository permissions. It does not create a public release, tag, push, or submit a listing. Publishing needs a separate explicit release decision. Keep manifest/root/package versions synchronized and update documented artifact paths together.

## Marketplace preparation

Official documentation supports local/GitHub installation and Marketplace partner submission. The bundle includes a README, MIT license, logo, version, author, suggested prompts and search keywords. The display name is Software Factory; the stable ID remains agy-software-factory. Node-invoked bin entrypoints do not rely on executable bits; directly executed future helpers belong under scripts/.

Before submission: qualify an actual install, discovery, and hook lifecycle in a disposable authenticated Antigravity environment; inspect the logo in light/dark themes; document tested versions; run the real full-stack example; review the final bundle; then submit through the intake linked from the official build guide. Loader validation does not guarantee admission.

Sources: [Plugin installation](https://antigravity.google/docs/plugins/), [Build and publish](https://antigravity.google/docs/build-plugins/), [Hooks](https://antigravity.google/docs/hooks/).
