# Third-party data in this directory

- `candidates.ts` is generated from OpenCC's `data/dictionary/STCharacters.txt`
  (Apache-2.0; see `../opencc/LICENSE` and `../opencc/LICENSE-Apache-2.0.txt`).
- `taiwan-md.ts` is generated from the terminology database of Taiwan.md
  (https://taiwan.md/terminology/, repository frank890417/taiwan-md,
  `data/terminology`) by `scripts/fork/vendor-taiwan-md-terms.mjs`. Taiwan.md's
  content is licensed under CC BY-SA 4.0
  (https://creativecommons.org/licenses/by-sa/4.0/), © Taiwan.md contributors.
  The file is an adaptation (Simplified keys and Taiwan wordings only, graded
  against zhtw's term lists) and is licensed under CC BY-SA 4.0 as well.
- Some of the added Taiwan terms in `rules.ts` (marked "zhtw" there) were checked
  against, and taken from, the term lists of rajatim/zhtw
  (https://github.com/rajatim/zhtw), under the MIT license below; the same lists
  grade the Taiwan.md entries.

## rajatim/zhtw

```
MIT License

Copyright (c) 2025 tim Insight

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
