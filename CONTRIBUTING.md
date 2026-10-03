# Contributing

This project is a prototype maintained at [hhhonzik/slack-to-buzz-proxy](https://github.com/hhhonzik/slack-to-buzz-proxy). Read `docs/CODEX_HANDOFF.md` for release status and `AGENTS.md` for implementation contracts. The licensing and public contribution policy will be finalized with the maintainer.

## Local work

Use Node 22.15+ or Node 24. Run `npm ci`, `npm run check`, `npm test`, and `npm run build`. All local tests use synthetic data and ephemeral test keys. `npm run preview -- examples/block-kit.json` exercises the actual renderer without sending anything.

Propose small changes tied to a compatibility gap or an operational failure. Include a synthetic fixture/regression test for changed behavior. Keep documentation and the compatibility matrix aligned with what is exercised. List live relay/sender tests separately from mocks in your change description.

Do not commit `.env`, secrets, SQLite databases, real webhook URLs, production alert payloads, private identities, or unredacted logs. `npm run init` generates personal local state; examples must remain synthetic. Ensure archives and container build contexts omit that state.

## Reporting issues

Include the proxy version, Node version, sender/relay versions, relevant stable error code, expected behavior, and a minimized synthetic payload. Do not paste webhook tokens, private keys, or alert content containing credentials.

## Before a stable release

Repository ownership and project name are set to hhhonzik/slack-to-buzz-proxy. The maintainer still needs to choose the license and add the corresponding LICENSE/copyright information. `package.json` currently uses `UNLICENSED` and `private:true` intentionally. Do not publish an npm package or claim official Slack, Grafana, Prometheus, or Buzz endorsement.

Set up the repository's private security reporting facility before accepting security reports. Pin CI action revisions and release image digests as part of the first release; build/publish automation currently does not upload artifacts to any registry.
