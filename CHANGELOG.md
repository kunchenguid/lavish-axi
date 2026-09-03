# Changelog

## [0.1.64](https://github.com/kunchenguid/lavish-axi/compare/lavish-axi-v0.1.63...lavish-axi-v0.1.64) (2026-09-03)


### Bug Fixes

* attachment upload 500s behind a reverse proxy (x-forwarded-host) ([#319](https://github.com/kunchenguid/lavish-axi/issues/319)) ([19a0800](https://github.com/kunchenguid/lavish-axi/commit/19a0800809c469d7924daf5cee1d80dbbef3175f))

## [0.1.63](https://github.com/kunchenguid/lavish-axi/compare/lavish-axi-v0.1.62...lavish-axi-v0.1.63) (2026-08-29)


### Bug Fixes

* **server:** keep agent-working presence across overlapping polls ([#301](https://github.com/kunchenguid/lavish-axi/issues/301)) ([0e77263](https://github.com/kunchenguid/lavish-axi/commit/0e77263cf20a95da49ab08c71c4176b38050fe73))

## [0.1.62](https://github.com/kunchenguid/lavish-axi/compare/lavish-axi-v0.1.61...lavish-axi-v0.1.62) (2026-08-24)


### Features

* **artifact-sdk:** close an empty annotation card on Escape ([#293](https://github.com/kunchenguid/lavish-axi/issues/293)) ([2b563e1](https://github.com/kunchenguid/lavish-axi/commit/2b563e17a9cb70757d77a1b979c811482d71d3b9)), closes [#292](https://github.com/kunchenguid/lavish-axi/issues/292)

## [0.1.61](https://github.com/kunchenguid/lavish-axi/compare/lavish-axi-v0.1.60...lavish-axi-v0.1.61) (2026-08-24)


### Features

* teach diagrams from zero, one concept at a time ([#290](https://github.com/kunchenguid/lavish-axi/issues/290)) ([21737a6](https://github.com/kunchenguid/lavish-axi/commit/21737a63a296a4c856b7b4fb7bdfe16e94b132d3))

## [0.1.60](https://github.com/kunchenguid/lavish-axi/compare/lavish-axi-v0.1.59...lavish-axi-v0.1.60) (2026-08-24)


### Features

* add automatic Tailscale phone access ([#289](https://github.com/kunchenguid/lavish-axi/issues/289)) ([443aaa9](https://github.com/kunchenguid/lavish-axi/commit/443aaa99c381851ea4e01d27b86af979166e7a28))
* **share:** publish a private link with a generated password ([#287](https://github.com/kunchenguid/lavish-axi/issues/287)) ([c9a9a8e](https://github.com/kunchenguid/lavish-axi/commit/c9a9a8e99d68acb15e78bc5fc1d15c5d53f5a357))


### Bug Fixes

* keep the shipped skill as a minimal CLI-deferring stub ([#286](https://github.com/kunchenguid/lavish-axi/issues/286)) ([f658fb8](https://github.com/kunchenguid/lavish-axi/commit/f658fb83a59441fc7da31f4a0b3bed18b0f73ff3))

## [0.1.59](https://github.com/kunchenguid/lavish-axi/compare/lavish-axi-v0.1.58...lavish-axi-v0.1.59) (2026-08-23)


### Bug Fixes

* **chrome:** prevent layout gate sticky failure traps ([#284](https://github.com/kunchenguid/lavish-axi/issues/284)) ([7024bc4](https://github.com/kunchenguid/lavish-axi/commit/7024bc464f63f117767adf8ab6e680e6f06f2aa2))

## [0.1.58](https://github.com/kunchenguid/lavish-axi/compare/lavish-axi-v0.1.57...lavish-axi-v0.1.58) (2026-08-23)


### Features

* default diagram guidance to hand-authored SVG, Mermaid becomes the whiteboard opt-in ([#282](https://github.com/kunchenguid/lavish-axi/issues/282)) ([ea7e0ad](https://github.com/kunchenguid/lavish-axi/commit/ea7e0ad5f0ed9548c57c3ff9ef808928f1e465bc))

## [0.1.57](https://github.com/kunchenguid/lavish-axi/compare/lavish-axi-v0.1.56...lavish-axi-v0.1.57) (2026-08-23)


### Bug Fixes

* make ended review sessions read-only ([#273](https://github.com/kunchenguid/lavish-axi/issues/273)) ([bafce3d](https://github.com/kunchenguid/lavish-axi/commit/bafce3d56eb8d9ed9853783da543ee0844182ac2))

## [0.1.56](https://github.com/kunchenguid/lavish-axi/compare/lavish-axi-v0.1.55...lavish-axi-v0.1.56) (2026-08-22)


### Bug Fixes

* replace clipped mobile conversation with bottom sheet ([#275](https://github.com/kunchenguid/lavish-axi/issues/275)) ([7d4e5a9](https://github.com/kunchenguid/lavish-axi/commit/7d4e5a9fe09dfa21e8edafb4252bc757ecf44a29))

## [0.1.55](https://github.com/kunchenguid/lavish-axi/compare/lavish-axi-v0.1.54...lavish-axi-v0.1.55) (2026-08-21)


### Bug Fixes

* **server:** restore taken feedback when a long-poll client disconnects ([#270](https://github.com/kunchenguid/lavish-axi/issues/270)) ([3b2c10f](https://github.com/kunchenguid/lavish-axi/commit/3b2c10f58dcbc95b81a8f17c48a960a9f5aee379))

## [0.1.54](https://github.com/kunchenguid/lavish-axi/compare/lavish-axi-v0.1.53...lavish-axi-v0.1.54) (2026-08-20)


### Features

* **attachments:** support image paste, drop, and picker uploads in the conversation composer ([#248](https://github.com/kunchenguid/lavish-axi/issues/248)) ([4726242](https://github.com/kunchenguid/lavish-axi/commit/47262422fe34efb8373909775d3532b7eb354bdc))


### Bug Fixes

* add semantic names to table annotations ([#256](https://github.com/kunchenguid/lavish-axi/issues/256)) ([d27e2e8](https://github.com/kunchenguid/lavish-axi/commit/d27e2e8b489a3504cb1620c61dffc6d79afcae49))
* **chrome:** recover a review that never finishes loading ([#268](https://github.com/kunchenguid/lavish-axi/issues/268)) ([30ef253](https://github.com/kunchenguid/lavish-axi/commit/30ef25389f409464a6f0a7d0121830e4a9335242))
* **cli:** put poll feedback ahead of the DOM snapshot in output ([#266](https://github.com/kunchenguid/lavish-axi/issues/266)) ([9f42941](https://github.com/kunchenguid/lavish-axi/commit/9f429413694b28e1d968af0ac5061e4efe4a7234))
* let artifact popups escape the iframe sandbox ([#258](https://github.com/kunchenguid/lavish-axi/issues/258)) ([c62b5f9](https://github.com/kunchenguid/lavish-axi/commit/c62b5f9606c06569df6a51949bae3d53e065dfc8))
* preserve Mermaid label line breaks ([#237](https://github.com/kunchenguid/lavish-axi/issues/237)) ([c7db61c](https://github.com/kunchenguid/lavish-axi/commit/c7db61c438e290a04c3c403625c1351699b9d326))
* **server:** keep sends available while an agent works and stop losing feedback on closed polls ([#265](https://github.com/kunchenguid/lavish-axi/issues/265)) ([cc186c2](https://github.com/kunchenguid/lavish-axi/commit/cc186c208e2cf5b30ffee782eda78b38ca79d387))
* **server:** reject foreign origins on mutating routes ([#257](https://github.com/kunchenguid/lavish-axi/issues/257)) ([ec50b1e](https://github.com/kunchenguid/lavish-axi/commit/ec50b1e7304466fd559e6c06b3259b3d2da6189e))

## [0.1.53](https://github.com/kunchenguid/lavish-axi/compare/lavish-axi-v0.1.52...lavish-axi-v0.1.53) (2026-08-18)


### Bug Fixes

* avoid phantom whiteboard conflicts ([#252](https://github.com/kunchenguid/lavish-axi/issues/252)) ([196d24f](https://github.com/kunchenguid/lavish-axi/commit/196d24f132e6361a432509e8f634ba16b8976154))

## [0.1.52](https://github.com/kunchenguid/lavish-axi/compare/lavish-axi-v0.1.51...lavish-axi-v0.1.52) (2026-08-15)


### Bug Fixes

* **whiteboard:** preserve Mermaid node label line breaks in Excalidraw ([#246](https://github.com/kunchenguid/lavish-axi/issues/246)) ([2dd70d8](https://github.com/kunchenguid/lavish-axi/commit/2dd70d8db771bf5bf1742a186a1ed196e1a16881))

## [0.1.51](https://github.com/kunchenguid/lavish-axi/compare/lavish-axi-v0.1.50...lavish-axi-v0.1.51) (2026-08-14)


### Features

* **attachments:** attach reference images to annotations and deliver them to the agent ([#188](https://github.com/kunchenguid/lavish-axi/issues/188)) ([3b25cbd](https://github.com/kunchenguid/lavish-axi/commit/3b25cbd00ae3406c79c681ca24d751a5bc84e761))

## [0.1.50](https://github.com/kunchenguid/lavish-axi/compare/lavish-axi-v0.1.49...lavish-axi-v0.1.50) (2026-08-11)


### Bug Fixes

* **server:** harden feedback submission boundaries ([#235](https://github.com/kunchenguid/lavish-axi/issues/235)) ([89412ca](https://github.com/kunchenguid/lavish-axi/commit/89412ca1c0c8490476edffa065317cd0e093afc8))

## [0.1.49](https://github.com/kunchenguid/lavish-axi/compare/lavish-axi-v0.1.48...lavish-axi-v0.1.49) (2026-08-11)


### Bug Fixes

* **server:** confine artifact asset route by realpath (symlink-escape hardening) ([#194](https://github.com/kunchenguid/lavish-axi/issues/194)) ([6215658](https://github.com/kunchenguid/lavish-axi/commit/62156587cd163f14e90c0e7014492d1961afa5f7))

## [0.1.48](https://github.com/kunchenguid/lavish-axi/compare/lavish-axi-v0.1.47...lavish-axi-v0.1.48) (2026-08-10)


### Features

* **cli:** guard against invisible unpainted artifacts ([#230](https://github.com/kunchenguid/lavish-axi/issues/230)) ([b285c40](https://github.com/kunchenguid/lavish-axi/commit/b285c40a55a4d84fdb321923794eff13f6fb5543))


### Bug Fixes

* streamline invisible artifact guidance ([#232](https://github.com/kunchenguid/lavish-axi/issues/232)) ([232972b](https://github.com/kunchenguid/lavish-axi/commit/232972beba9e0e4e75682c98f2aeb2cf01532122))

## [0.1.47](https://github.com/kunchenguid/lavish-axi/compare/lavish-axi-v0.1.46...lavish-axi-v0.1.47) (2026-08-09)


### Bug Fixes

* **chrome:** remove persistent layout issue banner ([#226](https://github.com/kunchenguid/lavish-axi/issues/226)) ([fb9107e](https://github.com/kunchenguid/lavish-axi/commit/fb9107e2d1e8e1820d93ad977a121f34a66e13be))

## [0.1.46](https://github.com/kunchenguid/lavish-axi/compare/lavish-axi-v0.1.45...lavish-axi-v0.1.46) (2026-08-07)


### Features

* add multiplexed event stream foundation ([#212](https://github.com/kunchenguid/lavish-axi/issues/212)) ([34ed7f3](https://github.com/kunchenguid/lavish-axi/commit/34ed7f39875e472546935237b0f545d08a54f828))
* **cli:** add self-contained Agent Plugin support ([#223](https://github.com/kunchenguid/lavish-axi/issues/223)) ([8b43c21](https://github.com/kunchenguid/lavish-axi/commit/8b43c21f4a6d4d8096db63601dce4f31a48a68a4))


### Bug Fixes

* **cli:** make version checks near-instant ([#222](https://github.com/kunchenguid/lavish-axi/issues/222)) ([8ef64df](https://github.com/kunchenguid/lavish-axi/commit/8ef64dff4980a367a904aff7f24a0d7edcba191c))
* restore long-poll-only feedback delivery ([#214](https://github.com/kunchenguid/lavish-axi/issues/214)) ([7c64184](https://github.com/kunchenguid/lavish-axi/commit/7c64184adce8b2b18c1cb072779305303b8079d9))

## [0.1.45](https://github.com/kunchenguid/lavish-axi/compare/lavish-axi-v0.1.44...lavish-axi-v0.1.45) (2026-07-31)


### Features

* add passive layout warning triage ([#210](https://github.com/kunchenguid/lavish-axi/issues/210)) ([3c75e1f](https://github.com/kunchenguid/lavish-axi/commit/3c75e1f86350a78bbad21b1779e559cd11738e52))

## [0.1.44](https://github.com/kunchenguid/lavish-axi/compare/lavish-axi-v0.1.43...lavish-axi-v0.1.44) (2026-07-23)


### Bug Fixes

* **cli:** suppress recurring poll wait ticks outside interactive terminals ([#179](https://github.com/kunchenguid/lavish-axi/issues/179)) ([50b0fac](https://github.com/kunchenguid/lavish-axi/commit/50b0facb61b5fc36cb1737e33b20d2894a64323b))
* execute every PR body compliance event ([#197](https://github.com/kunchenguid/lavish-axi/issues/197)) ([f5a1ecb](https://github.com/kunchenguid/lavish-axi/commit/f5a1ecb8e32cfa7eb61bc7c713befd99b180e121))

## [0.1.43](https://github.com/kunchenguid/lavish-axi/compare/lavish-axi-v0.1.42...lavish-axi-v0.1.43) (2026-07-22)


### Features

* **server:** support non-loopback hosts and reverse proxies ([879794a](https://github.com/kunchenguid/lavish-axi/commit/879794adf947d9ff8da18df013da82c0d604f695))


### Bug Fixes

* **server:** clear delivered-feedback working presence on agent reply ([#161](https://github.com/kunchenguid/lavish-axi/issues/161)) ([50a5477](https://github.com/kunchenguid/lavish-axi/commit/50a54774b1dfcaa96fce46765e6b156b5a8eab1d))
* **server:** reject trailing garbage after a bracketed IPv6 Host ([c229ef4](https://github.com/kunchenguid/lavish-axi/commit/c229ef49618a7f042b7004ca57e5a5733938e92f))
* **server:** validate the Host header to close DNS rebinding ([f016972](https://github.com/kunchenguid/lavish-axi/commit/f016972251556a83cd4712cf081a475cfcf3646a))

## [0.1.42](https://github.com/kunchenguid/lavish-axi/compare/lavish-axi-v0.1.41...lavish-axi-v0.1.42) (2026-07-14)


### Bug Fixes

* **skill:** require observable poll wake paths ([#174](https://github.com/kunchenguid/lavish-axi/issues/174)) ([15979b6](https://github.com/kunchenguid/lavish-axi/commit/15979b62e6bf57f99fdbc95015e5359363168303))

## [0.1.41](https://github.com/kunchenguid/lavish-axi/compare/lavish-axi-v0.1.40...lavish-axi-v0.1.41) (2026-07-14)


### Bug Fixes

* **cli:** keep Codex polls attached to active turns ([#165](https://github.com/kunchenguid/lavish-axi/issues/165)) ([ab31405](https://github.com/kunchenguid/lavish-axi/commit/ab31405882f950696a2ddc79deb90d4caada7543))
* **whiteboard:** prevent Excalidraw label clipping ([#173](https://github.com/kunchenguid/lavish-axi/issues/173)) ([ffe54f0](https://github.com/kunchenguid/lavish-axi/commit/ffe54f01c305b9732b8795695dc3706c5a8dccc3))

## [0.1.40](https://github.com/kunchenguid/lavish-axi/compare/lavish-axi-v0.1.39...lavish-axi-v0.1.40) (2026-07-11)


### Features

* edit Mermaid diagrams as whiteboards ([#166](https://github.com/kunchenguid/lavish-axi/issues/166)) ([94a181c](https://github.com/kunchenguid/lavish-axi/commit/94a181c2954d5ad49249d85681be61a0385ec47a))

## [0.1.39](https://github.com/kunchenguid/lavish-axi/compare/lavish-axi-v0.1.38...lavish-axi-v0.1.39) (2026-07-10)


### Bug Fixes

* **chrome:** add conversation empty state ([#155](https://github.com/kunchenguid/lavish-axi/issues/155)) ([6c81509](https://github.com/kunchenguid/lavish-axi/commit/6c81509c098cafc646c0c3d5fd7e4f462cf30cb1))
* sync Mermaid diagrams with page themes ([#162](https://github.com/kunchenguid/lavish-axi/issues/162)) ([957eab4](https://github.com/kunchenguid/lavish-axi/commit/957eab4c11474a6ae15988a9b10d64ad08670a73))

## [0.1.38](https://github.com/kunchenguid/lavish-axi/compare/lavish-axi-v0.1.37...lavish-axi-v0.1.38) (2026-07-08)


### Bug Fixes

* make Send & End a top-level composer action ([#153](https://github.com/kunchenguid/lavish-axi/issues/153)) ([094bb40](https://github.com/kunchenguid/lavish-axi/commit/094bb40170e1718f3f8badbd627dbea6dd0b9536))

## [0.1.37](https://github.com/kunchenguid/lavish-axi/compare/lavish-axi-v0.1.36...lavish-axi-v0.1.37) (2026-07-07)


### Features

* **server:** surface artifact favicon and title on the Lavish tab ([#116](https://github.com/kunchenguid/lavish-axi/issues/116)) ([8b9f79f](https://github.com/kunchenguid/lavish-axi/commit/8b9f79f0c36523403cec8e05b89b500a2e8902bd))


### Bug Fixes

* **chrome:** keep composer visible with long feedback queues ([#146](https://github.com/kunchenguid/lavish-axi/issues/146)) ([a36aeb6](https://github.com/kunchenguid/lavish-axi/commit/a36aeb676eef161bd58b227a1e171fa2f6b5e071))

## [0.1.36](https://github.com/kunchenguid/lavish-axi/compare/lavish-axi-v0.1.35...lavish-axi-v0.1.36) (2026-07-03)


### Features

* **chrome:** add annotate/explore mode hotkey ([#138](https://github.com/kunchenguid/lavish-axi/issues/138)) ([9d3e4f2](https://github.com/kunchenguid/lavish-axi/commit/9d3e4f28132c969d0d1975ee526c3beb33a47259))
* **sdk:** first-class zoomable, annotatable mermaid diagrams ([#124](https://github.com/kunchenguid/lavish-axi/issues/124)) ([e295450](https://github.com/kunchenguid/lavish-axi/commit/e2954503e11d334bf2135f7c64902ea59056ec33))

## [0.1.35](https://github.com/kunchenguid/lavish-axi/compare/lavish-axi-v0.1.34...lavish-axi-v0.1.35) (2026-07-02)


### Bug Fixes

* respect user-ended Lavish sessions ([#132](https://github.com/kunchenguid/lavish-axi/issues/132)) ([8ca248b](https://github.com/kunchenguid/lavish-axi/commit/8ca248bc4334316460566fccdd1ef33353b74626))

## [0.1.34](https://github.com/kunchenguid/lavish-axi/compare/lavish-axi-v0.1.33...lavish-axi-v0.1.34) (2026-07-02)


### Bug Fixes

* improve layout audit accuracy and warning persistence ([#129](https://github.com/kunchenguid/lavish-axi/issues/129)) ([6d91f4b](https://github.com/kunchenguid/lavish-axi/commit/6d91f4b5f4fe6c198b7599a71041bf25a9f295b2))

## [0.1.33](https://github.com/kunchenguid/lavish-axi/compare/lavish-axi-v0.1.32...lavish-axi-v0.1.33) (2026-07-01)


### Features

* add artifact export and hosted sharing ([#123](https://github.com/kunchenguid/lavish-axi/issues/123)) ([d7deba1](https://github.com/kunchenguid/lavish-axi/commit/d7deba16aec45a5752a853303f60b5c8dc45e535))
* **cli:** add GitHub Copilot CLI session start hook support ([#106](https://github.com/kunchenguid/lavish-axi/issues/106)) ([0b3e28e](https://github.com/kunchenguid/lavish-axi/commit/0b3e28eae0a139540b7b274293cea98d49961dc4))
* **cli:** tell agents to screenshot existing UI instead of describing it ([#113](https://github.com/kunchenguid/lavish-axi/issues/113)) ([2189f60](https://github.com/kunchenguid/lavish-axi/commit/2189f601b147062a69633381d893886a2201361b))
* disclose ht-ml.app in share flows ([#126](https://github.com/kunchenguid/lavish-axi/issues/126)) ([cd6016a](https://github.com/kunchenguid/lavish-axi/commit/cd6016a3381ad713c5340db0bf8b53e36ed3ef9c))


### Bug Fixes

* **chrome:** center circular close button icons ([#125](https://github.com/kunchenguid/lavish-axi/issues/125)) ([47deaef](https://github.com/kunchenguid/lavish-axi/commit/47deaef107cac56deda4dcab5e9c6d903f9e42b4))

## [0.1.32](https://github.com/kunchenguid/lavish-axi/compare/lavish-axi-v0.1.31...lavish-axi-v0.1.32) (2026-06-27)


### Features

* add layout audit curtain gate ([#97](https://github.com/kunchenguid/lavish-axi/issues/97)) ([0fa3968](https://github.com/kunchenguid/lavish-axi/commit/0fa3968fdf1f7184f52a8d5eb6eeeccc106b46cb))
* **cli:** add Lavish playbook routing guidance ([#99](https://github.com/kunchenguid/lavish-axi/issues/99)) ([03cb069](https://github.com/kunchenguid/lavish-axi/commit/03cb0696ed1c5069db8b464e7299fd87098b1fff))
* **cli:** expose SDK self-update command ([#110](https://github.com/kunchenguid/lavish-axi/issues/110)) ([26473c7](https://github.com/kunchenguid/lavish-axi/commit/26473c72e715986cee7130dfea8402007fc9e522))
* report browser layout warnings through poll ([#95](https://github.com/kunchenguid/lavish-axi/issues/95)) ([4809102](https://github.com/kunchenguid/lavish-axi/commit/480910213eb2f12d2c4c514ee4a5c1f03ce1655f))


### Bug Fixes

* let summary controls toggle in annotation mode ([#100](https://github.com/kunchenguid/lavish-axi/issues/100)) ([3eb70c6](https://github.com/kunchenguid/lavish-axi/commit/3eb70c6e8ccdcdbc725b5d282327b0cc08dd1868))

## [0.1.31](https://github.com/kunchenguid/lavish-axi/compare/lavish-axi-v0.1.30...lavish-axi-v0.1.31) (2026-06-16)


### Bug Fixes

* supersede unsent input choices ([#92](https://github.com/kunchenguid/lavish-axi/issues/92)) ([352dd0d](https://github.com/kunchenguid/lavish-axi/commit/352dd0d91d00f7914e23282b4b036eaa1ba7ecd2))

## [0.1.30](https://github.com/kunchenguid/lavish-axi/compare/lavish-axi-v0.1.29...lavish-axi-v0.1.30) (2026-06-14)


### Bug Fixes

* clarify artifact design system guidance ([#89](https://github.com/kunchenguid/lavish-axi/issues/89)) ([6486407](https://github.com/kunchenguid/lavish-axi/commit/64864071f739344e3c148e4d570430e0495de586))

## [0.1.29](https://github.com/kunchenguid/lavish-axi/compare/lavish-axi-v0.1.28...lavish-axi-v0.1.29) (2026-06-12)


### Features

* rename diff playbook to code ([#85](https://github.com/kunchenguid/lavish-axi/issues/85)) ([0e3487f](https://github.com/kunchenguid/lavish-axi/commit/0e3487f3bd95ca9a1902fb1dfbb462c7d218fe44))

## [0.1.28](https://github.com/kunchenguid/lavish-axi/compare/lavish-axi-v0.1.27...lavish-axi-v0.1.28) (2026-06-11)


### Features

* **server:** configurable bind address and link hostname ([#61](https://github.com/kunchenguid/lavish-axi/issues/61)) ([4bbdafd](https://github.com/kunchenguid/lavish-axi/commit/4bbdafd3dc41233540b07e034359973506bef6d9))
* **skills:** add Hermes metadata to lavish skill ([#82](https://github.com/kunchenguid/lavish-axi/issues/82)) ([e634c23](https://github.com/kunchenguid/lavish-axi/commit/e634c232ec64e97be2643b33235d3fe4c39eb6b8))


### Bug Fixes

* **skills:** hide internal agent skills from discovery ([#80](https://github.com/kunchenguid/lavish-axi/issues/80)) ([a4bd520](https://github.com/kunchenguid/lavish-axi/commit/a4bd520bbbda62a06de6a8c592cd5aebdc5ef055))

## [0.1.27](https://github.com/kunchenguid/lavish-axi/compare/lavish-axi-v0.1.26...lavish-axi-v0.1.27) (2026-06-11)


### Bug Fixes

* improve Lavish design fallback guidance ([#78](https://github.com/kunchenguid/lavish-axi/issues/78)) ([db9f294](https://github.com/kunchenguid/lavish-axi/commit/db9f2943a19ef626ccc233d7b4d66dafdf52cc51))

## [0.1.26](https://github.com/kunchenguid/lavish-axi/compare/lavish-axi-v0.1.25...lavish-axi-v0.1.26) (2026-06-11)


### Bug Fixes

* **cli:** make interrupted poll guidance reliable ([#76](https://github.com/kunchenguid/lavish-axi/issues/76)) ([1a01e26](https://github.com/kunchenguid/lavish-axi/commit/1a01e2603a545bea773e5126beb653ba84d1a8b5))

## [0.1.25](https://github.com/kunchenguid/lavish-axi/compare/lavish-axi-v0.1.24...lavish-axi-v0.1.25) (2026-06-11)


### Bug Fixes

* **cli:** improve poll and design guidance ([#74](https://github.com/kunchenguid/lavish-axi/issues/74)) ([302efac](https://github.com/kunchenguid/lavish-axi/commit/302efac1c73e486a01486dd394bc49f79fd8ae7b))

## [0.1.24](https://github.com/kunchenguid/lavish-axi/compare/lavish-axi-v0.1.23...lavish-axi-v0.1.24) (2026-06-11)


### Features

* **cli:** guide agents to combine relevant playbooks ([#73](https://github.com/kunchenguid/lavish-axi/issues/73)) ([d0c6e47](https://github.com/kunchenguid/lavish-axi/commit/d0c6e47d9eaed2efb40c0a14a152ffb8f602900e))


### Bug Fixes

* Add Ctrl+Enter immediate-send shortcut to the annotation card ([#71](https://github.com/kunchenguid/lavish-axi/issues/71)) ([9922767](https://github.com/kunchenguid/lavish-axi/commit/9922767ca7f7eb5e4bec02345464fcf107fab42c))

## [0.1.23](https://github.com/kunchenguid/lavish-axi/compare/lavish-axi-v0.1.22...lavish-axi-v0.1.23) (2026-06-10)


### Features

* **skill:** support /lavish invocation ([#67](https://github.com/kunchenguid/lavish-axi/issues/67)) ([cd87b1f](https://github.com/kunchenguid/lavish-axi/commit/cd87b1f057848b1114ad414e99c27808ad044222))

## [0.1.22](https://github.com/kunchenguid/lavish-axi/compare/lavish-axi-v0.1.21...lavish-axi-v0.1.22) (2026-06-10)


### Features

* sync lavish design skill to v2 ([#65](https://github.com/kunchenguid/lavish-axi/issues/65)) ([d9cfc9d](https://github.com/kunchenguid/lavish-axi/commit/d9cfc9d42ae8a7875626878d10711cd20f23f2af))

## [0.1.21](https://github.com/kunchenguid/lavish-axi/compare/lavish-axi-v0.1.20...lavish-axi-v0.1.21) (2026-06-10)


### Features

* **chrome:** align editor chrome with v2 UI ([#63](https://github.com/kunchenguid/lavish-axi/issues/63)) ([da6c19e](https://github.com/kunchenguid/lavish-axi/commit/da6c19ec4882024a55333adc83ca481ec16d09c8))

## [0.1.20](https://github.com/kunchenguid/lavish-axi/compare/lavish-axi-v0.1.19...lavish-axi-v0.1.20) (2026-06-07)


### Features

* send on Enter in chat input and annotation card ([#58](https://github.com/kunchenguid/lavish-axi/issues/58)) ([e88679f](https://github.com/kunchenguid/lavish-axi/commit/e88679f6a02a3ba4fdd6424d569e34f919025077))
* **skills:** add installable Lavish agent skill ([#59](https://github.com/kunchenguid/lavish-axi/issues/59)) ([5f7cb2e](https://github.com/kunchenguid/lavish-axi/commit/5f7cb2e4263220ff38f63117ae6293616278fdf6))

## [0.1.19](https://github.com/kunchenguid/lavish-axi/compare/lavish-axi-v0.1.18...lavish-axi-v0.1.19) (2026-06-05)


### Bug Fixes

* allow native form controls during annotation ([#56](https://github.com/kunchenguid/lavish-axi/issues/56)) ([e355502](https://github.com/kunchenguid/lavish-axi/commit/e355502fb312620108c2dcd38b4280a23e9e27e1))

## [0.1.18](https://github.com/kunchenguid/lavish-axi/compare/lavish-axi-v0.1.17...lavish-axi-v0.1.18) (2026-05-27)


### Features

* **cli:** add server shutdown controls ([#54](https://github.com/kunchenguid/lavish-axi/issues/54)) ([33c5b45](https://github.com/kunchenguid/lavish-axi/commit/33c5b4549693d7c8fb5ca8dc59595dcf9377b4cd))

## [0.1.17](https://github.com/kunchenguid/lavish-axi/compare/lavish-axi-v0.1.16...lavish-axi-v0.1.17) (2026-05-24)


### Features

* **cli:** broaden plan playbook guidance ([#52](https://github.com/kunchenguid/lavish-axi/issues/52)) ([aa533c4](https://github.com/kunchenguid/lavish-axi/commit/aa533c42c77a696ac0817402688b17cf29c5bdd5))

## [0.1.16](https://github.com/kunchenguid/lavish-axi/compare/lavish-axi-v0.1.15...lavish-axi-v0.1.16) (2026-05-24)


### Bug Fixes

* **cli:** prioritize project design guidance ([#50](https://github.com/kunchenguid/lavish-axi/issues/50)) ([ee782c0](https://github.com/kunchenguid/lavish-axi/commit/ee782c04d737d888f9f3b3bae1916137d791516b))

## [0.1.15](https://github.com/kunchenguid/lavish-axi/compare/lavish-axi-v0.1.14...lavish-axi-v0.1.15) (2026-05-23)


### Bug Fixes

* preserve artifact scroll on hot reload ([#48](https://github.com/kunchenguid/lavish-axi/issues/48)) ([81599a1](https://github.com/kunchenguid/lavish-axi/commit/81599a1f70ff08732b4a809e8634f5f4942b9d3b))

## [0.1.14](https://github.com/kunchenguid/lavish-axi/compare/lavish-axi-v0.1.13...lavish-axi-v0.1.14) (2026-05-23)


### Bug Fixes

* **cli:** require explicit agent hook setup ([#46](https://github.com/kunchenguid/lavish-axi/issues/46)) ([4a250b8](https://github.com/kunchenguid/lavish-axi/commit/4a250b843edbe4204599526c753bc94b798c9785))

## [0.1.13](https://github.com/kunchenguid/lavish-axi/compare/lavish-axi-v0.1.12...lavish-axi-v0.1.13) (2026-05-23)


### Bug Fixes

* support local artifact assets in hidden directories ([#44](https://github.com/kunchenguid/lavish-axi/issues/44)) ([2528e8e](https://github.com/kunchenguid/lavish-axi/commit/2528e8e571cfd0ed299be842df9943c56868f4ac))

## [0.1.12](https://github.com/kunchenguid/lavish-axi/compare/lavish-axi-v0.1.11...lavish-axi-v0.1.12) (2026-05-16)


### Bug Fixes

* harden feedback polling and queued prompts ([#41](https://github.com/kunchenguid/lavish-axi/issues/41)) ([ec1e664](https://github.com/kunchenguid/lavish-axi/commit/ec1e6643533a01f93389532d382897b0451201ee))

## [0.1.11](https://github.com/kunchenguid/lavish-axi/compare/lavish-axi-v0.1.10...lavish-axi-v0.1.11) (2026-05-15)


### Bug Fixes

* keep Lavish artifacts portable by default ([#40](https://github.com/kunchenguid/lavish-axi/issues/40)) ([6dc80bc](https://github.com/kunchenguid/lavish-axi/commit/6dc80bc6d411a19c48d14444d8aa2a13afdaf58f))
* **server:** prevent live reload watcher stalls ([#38](https://github.com/kunchenguid/lavish-axi/issues/38)) ([cc1c841](https://github.com/kunchenguid/lavish-axi/commit/cc1c8411d3410b591fd5d1de945ba93c889af0e7))

## [0.1.10](https://github.com/kunchenguid/lavish-axi/compare/lavish-axi-v0.1.9...lavish-axi-v0.1.10) (2026-05-14)


### Bug Fixes

* **cli:** require polling before user replies ([#33](https://github.com/kunchenguid/lavish-axi/issues/33)) ([c23c86c](https://github.com/kunchenguid/lavish-axi/commit/c23c86c499cd16d7cf23ee7d48dca8ee7b74f174))

## [0.1.9](https://github.com/kunchenguid/lavish-axi/compare/lavish-axi-v0.1.8...lavish-axi-v0.1.9) (2026-05-13)


### Bug Fixes

* **server:** track agent presence across polling states ([#31](https://github.com/kunchenguid/lavish-axi/issues/31)) ([351d7b4](https://github.com/kunchenguid/lavish-axi/commit/351d7b4174fb4f64b7683ea85a93537ecbb33ad3))

## [0.1.8](https://github.com/kunchenguid/lavish-axi/compare/lavish-axi-v0.1.7...lavish-axi-v0.1.8) (2026-05-13)


### Bug Fixes

* trigger release ([9bbf27f](https://github.com/kunchenguid/lavish-axi/commit/9bbf27fe77f0e8baa656b577e27fc536d3c7474a))

## [0.1.7](https://github.com/kunchenguid/lavish-axi/compare/lavish-axi-v0.1.6...lavish-axi-v0.1.7) (2026-05-12)


### Features

* add input feedback controls ([#17](https://github.com/kunchenguid/lavish-axi/issues/17)) ([8eda036](https://github.com/kunchenguid/lavish-axi/commit/8eda036cfd6604823fad4945f9970b32a40e520a))

## [0.1.6](https://github.com/kunchenguid/lavish-axi/compare/lavish-axi-v0.1.5...lavish-axi-v0.1.6) (2026-05-12)


### Features

* **cli:** inject packaged design assets ([#16](https://github.com/kunchenguid/lavish-axi/issues/16)) ([2eb6170](https://github.com/kunchenguid/lavish-axi/commit/2eb61706823257a677bd8490e97bfe20a98080fa))


### Bug Fixes

* upgrade axi js sdk ([#14](https://github.com/kunchenguid/lavish-axi/issues/14)) ([dfb07f8](https://github.com/kunchenguid/lavish-axi/commit/dfb07f8862867f07e907c5ad975e14738c0992b2))

## [0.1.5](https://github.com/kunchenguid/lavish-axi/compare/lavish-axi-v0.1.4...lavish-axi-v0.1.5) (2026-05-12)


### Features

* **cli:** add artifact guidance playbooks ([#12](https://github.com/kunchenguid/lavish-axi/issues/12)) ([b13f033](https://github.com/kunchenguid/lavish-axi/commit/b13f033973f91935af97e0688574a0767e66463b))

## [0.1.4](https://github.com/kunchenguid/lavish-axi/compare/lavish-axi-v0.1.3...lavish-axi-v0.1.4) (2026-05-12)


### Features

* support text range annotations ([#10](https://github.com/kunchenguid/lavish-axi/issues/10)) ([dd0ed5c](https://github.com/kunchenguid/lavish-axi/commit/dd0ed5c1340e945ddd33ebb66317b5e28c78f3e6))


### Bug Fixes

* **cli:** restart stale servers after upgrades ([#6](https://github.com/kunchenguid/lavish-axi/issues/6)) ([d473557](https://github.com/kunchenguid/lavish-axi/commit/d4735576a0fb3933304a4c1394195b512d60ccda))

## [0.1.3](https://github.com/kunchenguid/lavish-axi/compare/lavish-axi-v0.1.2...lavish-axi-v0.1.3) (2026-05-12)


### Bug Fixes

* metadata ([0ac6980](https://github.com/kunchenguid/lavish-axi/commit/0ac698092c94c0f7c91011ad58db2ddfe673a680))

## [0.1.2](https://github.com/kunchenguid/lavish-axi/compare/lavish-axi-v0.1.1...lavish-axi-v0.1.2) (2026-05-12)


### Features

* **cli:** improve AXI home guidance ([#4](https://github.com/kunchenguid/lavish-axi/issues/4)) ([70b5a30](https://github.com/kunchenguid/lavish-axi/commit/70b5a30bd2c0cadb97068fa79da316db4a6895ec))


### Bug Fixes

* ignore changelog in prettier checks ([c18d955](https://github.com/kunchenguid/lavish-axi/commit/c18d955af9cf3892150fc207be783c1b0bc90a74))

## [0.1.1](https://github.com/kunchenguid/lavish-axi/compare/lavish-axi-v0.1.0...lavish-axi-v0.1.1) (2026-05-12)


### Features

* initial commit ([7f1fc95](https://github.com/kunchenguid/lavish-axi/commit/7f1fc957f9d24a5ebae38fdfe43ad3cb717929b7))


### Bug Fixes

* editor chrome refresh ([#2](https://github.com/kunchenguid/lavish-axi/issues/2)) ([68caaef](https://github.com/kunchenguid/lavish-axi/commit/68caaef46fadf767ed70bf215a5fe9bda44b3190))
