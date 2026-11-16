# Changelog

## [0.6.0](https://github.com/marmos91/skills/compare/v0.5.0...v0.6.0) (2026-11-16)


### Features

* **bench:** pr-review recall benchmark on past PRs with known bugs ([#90](https://github.com/marmos91/skills/issues/90)) ([6c18df5](https://github.com/marmos91/skills/commit/6c18df57abf736182194274e7fd27e9c4a7757c0))
* **pr-review:** pre-existing level that posts once and never blocks ([#91](https://github.com/marmos91/skills/issues/91)) ([b89f19c](https://github.com/marmos91/skills/commit/b89f19c241b323525ef5d32266cca0c4b8435e28))


### Bug Fixes

* **pr-converge:** close the edges left after [#73](https://github.com/marmos91/skills/issues/73) ([#89](https://github.com/marmos91/skills/issues/89)) ([4f237bc](https://github.com/marmos91/skills/commit/4f237bce09a2655366472b8e698f7b9c4cfa6d3d))
* **pr-land:** edges left after [#62](https://github.com/marmos91/skills/issues/62) ([#88](https://github.com/marmos91/skills/issues/88)) ([c5e0888](https://github.com/marmos91/skills/commit/c5e08883af00321b8452bf78da9c28f8e0ea2697))
* **pr-review:** approve a clean review once CI passes, and say why not ([#85](https://github.com/marmos91/skills/issues/85)) ([6c80c43](https://github.com/marmos91/skills/commit/6c80c436352d5fa8a8a6641a1342564f8871f5d6))
* **pr-review:** keep pre-existing off changed lines and allow it on every pass ([#97](https://github.com/marmos91/skills/issues/97)) ([b6d42dd](https://github.com/marmos91/skills/commit/b6d42dd84b28e2d9e105f8c43e8413b2d8da49f6))
* **secret-scan:** real push repos for pr-land and pr-respond, gitleaks allow list, multi-line sops values ([#86](https://github.com/marmos91/skills/issues/86)) ([8d7a996](https://github.com/marmos91/skills/commit/8d7a996cc69b349d6152d25accdce41bed6308e3))

## [0.5.0](https://github.com/marmos91/skills/compare/v0.4.0...v0.5.0) (2026-11-16)


### Features

* **pr-review:** learn rejected findings in .pr-review/learnings.md ([#79](https://github.com/marmos91/skills/issues/79)) ([07f60fc](https://github.com/marmos91/skills/commit/07f60fca371f53a294344d9d437e4a4e0c4c2b80))
* **pr-review:** set a pr-review commit status on the reviewed head ([#80](https://github.com/marmos91/skills/issues/80)) ([47bf2eb](https://github.com/marmos91/skills/commit/47bf2ebfd5ae66eebdb5aa4744291fce2ab05c4f))


### Bug Fixes

* **pr-review:** key questions and settled records by fingerprint and line ([#81](https://github.com/marmos91/skills/issues/81)) ([78617a5](https://github.com/marmos91/skills/commit/78617a5c1bd1efe17276030d3df9a5675789815e))

## [0.4.0](https://github.com/marmos91/skills/compare/v0.3.0...v0.4.0) (2026-11-16)


### Features

* **pr-converge:** drive a PR from open to merged ([#73](https://github.com/marmos91/skills/issues/73)) ([365924e](https://github.com/marmos91/skills/commit/365924e024b8de171709d53fc3b71b9b51888a6a))
* **pr-review:** link threads, code and RFCs in posted reviews ([#75](https://github.com/marmos91/skills/issues/75)) ([8bd3fec](https://github.com/marmos91/skills/commit/8bd3fec88762c926abb8b69c6c5f6825ac876449))

## [0.3.0](https://github.com/marmos91/skills/compare/v0.2.1...v0.3.0) (2026-11-16)


### Features

* **pr-land:** merge a converged PR and clean up ([#62](https://github.com/marmos91/skills/issues/62)) ([68df9da](https://github.com/marmos91/skills/commit/68df9dadb7233d91ac20cc39e962babd68aba4fb))
* **secret-scan:** one shared check before any push or post ([#63](https://github.com/marmos91/skills/issues/63)) ([82235b9](https://github.com/marmos91/skills/commit/82235b95fbd9807c5efb6763146f0c9d538640cc))


### Bug Fixes

* **pr-review:** keep seat drops out of the posted summary ([#66](https://github.com/marmos91/skills/issues/66)) ([8f58cb8](https://github.com/marmos91/skills/commit/8f58cb8f14af430034177dc61f4a0144c4b34f60))
* **pr-review:** proof-logic audit ([#64](https://github.com/marmos91/skills/issues/64)) ([1048e51](https://github.com/marmos91/skills/commit/1048e5156a1b544bf2e488ddd457f7fa00e188ae))

## [0.2.1](https://github.com/marmos91/skills/compare/v0.2.0...v0.2.1) (2026-11-14)


### Bug Fixes

* **pr-review:** setup-check boundary audit ([#58](https://github.com/marmos91/skills/issues/58)) ([#60](https://github.com/marmos91/skills/issues/60)) ([6017930](https://github.com/marmos91/skills/commit/6017930de8a73fdbc5cbfd3578e07164fbcb1326))

## [0.2.0](https://github.com/marmos91/skills/compare/v0.1.0...v0.2.0) (2026-11-13)


### Features

* **pr-open:** take a branch to a review-ready PR ([#50](https://github.com/marmos91/skills/issues/50)) ([c9e1b09](https://github.com/marmos91/skills/commit/c9e1b0979e3d177d4d39fd5b8955c07a556460cb)), closes [#36](https://github.com/marmos91/skills/issues/36)
* **pr-respond:** fix review findings on your own PR until it converges ([#44](https://github.com/marmos91/skills/issues/44)) ([55e3ae8](https://github.com/marmos91/skills/commit/55e3ae8b2b4c9c3c0edc8076e70a861a29420334)), closes [#35](https://github.com/marmos91/skills/issues/35) [#54](https://github.com/marmos91/skills/issues/54)
* **pr-review:** proven findings at full depth ([#48](https://github.com/marmos91/skills/issues/48)) ([a9c1775](https://github.com/marmos91/skills/commit/a9c1775d4f963304b5a4fe1f5cc43c76d0e7d2ac))
* **pr-review:** review depth and setup checks ([#47](https://github.com/marmos91/skills/issues/47)) ([ef56493](https://github.com/marmos91/skills/commit/ef564934084bb925692832d633915f4ee3bb7eab))


### Bug Fixes

* **pr-review:** one trust check by repo permission ([#57](https://github.com/marmos91/skills/issues/57)) ([e933a31](https://github.com/marmos91/skills/commit/e933a3131879bba6c3ae554d8cfa29d4794a333b))
