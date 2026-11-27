# png-squeeze-01 — lossless PNG squeezer

[![make.fun · png-squeeze-01-run-20261127](https://make.fun/badge/png-squeeze-01-run-20261127.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)
[![rank](https://make.fun/badge/png-squeeze-01-run-20261127/wayangprint/makefun-png-squeeze-01/rank.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)
[![reward](https://make.fun/badge/png-squeeze-01-run-20261127/wayangprint/makefun-png-squeeze-01/reward.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)

Program Node 22 (erasable TypeScript, only built-in `node:` modules) that
rewrites 1280×720 RGBA screenshots as the smallest lossless PNG it can find.

How it works:
- Own PNG decoder (chunk parse, inflate, unfilter) and encoder (CRC-32,
  IHDR / PLTE / tRNS / IDAT / IEND only, bit depth 8, non-interlaced).
- Colour-type reduction: palette (by count and by luminance, transparent
  entries first), grey, grey+alpha, RGB, RGBA, and a tRNS key when a single
  fully-transparent colour can replace the alpha channel.
- Per-row filter search: fixed 0–4, minimum signed-sum, fewest distinct
  byte pairs, and brute force (each filter trial deflated with the previous
  32 KiB as dictionary).
- Screening with zlib level 6; the winner is re-encoded at level 9 with
  default, filtered and Huffman-only strategies, smallest wins.
- Fully deterministic: no clock, no randomness. One run covers i001–i008.

Run: `node main.ts` with `MAKEFUN_INPUT_DIR` / `MAKEFUN_OUTPUT_DIR`
(defaults `/input` and `/output`).
