# MARCUUS

macOS app (Electron + React).

## Develop

```bash
npm install
npm run start   # build + run
npm test
```

## Release

```bash
# bump "version" in package.json, commit, then:
npm run release -- "$(cat notes.txt)"
```

`scripts/release.mjs` runs the tests, builds both Macs, publishes the files and updates `latest.json`.
The notes only go into `latest.json`, for the app's update screen.

## Licence

GPL-3.0, see [LICENSE](LICENSE).
