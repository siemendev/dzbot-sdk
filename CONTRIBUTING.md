# Contributing to @dzbot/sdk

Issues and pull requests are welcome. Questions are also welcome on the
[dzbot Discord](https://discord.gg/Cg2kSMa6YM).

## Develop

You need Node.js 20 or newer and Java 11 or newer (for the OpenAPI generator).

```bash
npm install
npm run generate    # the typed client in generated/, from https://api.dzbot.de/api/docs.json
npm run typecheck
npm test
```

`generated/` is not part of the repository: it is produced from the public API description, the same way dzbot
produces its own client. Set `API_DOCS_URL` to generate it from another description.

The hand-written SDK lives in `src/`; `src/api.ts` re-exports the generated client as `@dzbot/sdk/api`. The npm
package is built and published by dzbot.

## Pull requests

- Keep a pull request to one change and say in its description what it changes for someone using the SDK.
- Add or adjust a test under `test/` for behaviour you change.

## Sign-off (DCO)

Contributions are accepted under the [Developer Certificate of Origin 1.1](https://developercertificate.org/): by
signing off a commit you confirm that you wrote it or otherwise have the right to submit it under the project's
license. Sign off every commit with `git commit -s`. A check on every pull request looks for it.

## License

By contributing you agree that your contribution is licensed under the [MIT License](LICENSE), like the rest of the
repository.
