# Writing rules

These rules apply to each review body, inline comment and reply. The reader
is the author of the PR. The author knows the code, so start with the point.

## Sentences

- Write short sentences. Put one idea in each sentence. Use active voice.
- Use plain words: "use", not "leverage"; "is", not "serves as".
- Show code instead of prose when code is shorter.
- Write each claim one time. Do not end with a line that repeats it.
- Name the file, the function and the input. Do not write "this may cause
  issues"; write what breaks and when.
- Use a qualifier ("may", "probably") only for real doubt.

## Do not write

- A contrast that adds weight only: "not X but Y", "not just X, Y", "X, not
  Y" when nobody said X.
- A run-up before the point: "Let's look at", "Here's the thing",
  "Honestly,", "It's worth noting that", "Note that".
- An answer to an objection that nobody made: "To be clear", "I'm not saying".
- A list of 3 when the meaning has 1 or 2 parts.
- These words: crucial, key (as an adjective), robust (unless technical),
  delve, leverage, seamless, enhance, ensure, comprehensive, meticulous,
  pivotal, underscore, showcase, valuable, additionally, actually.
- Praise or thanks: "Great PR", "Nice work", "Thanks for". Chat residue:
  "I hope this helps", "Let me know", "Happy to help".
- Em dashes or en dashes. Use a period, a comma, a colon or parentheses.
- Bold labels on each list item, emojis, title case in headings.
- A signature, a note that a tool or a model wrote the text, or a marker.

## Inline comment layout

One finding per comment, in this order:

1. The severity label, then a title that states the conclusion with a verb:
   `must: Reject port 0`. Use the repo's labels if its guidance sets others.
2. The case in one line. Say where each claim comes from: "(ran `cmd`)",
   "(read a.js:42)", or "I think" when you did not check.
3. A paste-ready fix: a `suggestion` block when it replaces only the
   commented line, else a `diff` block or the exact text to add.

A question says what each answer changes: "question: Can `id` be empty? If yes,
line 42 reads past the end; if no, drop the check." Credit what the author got
right, and link the PR or commit that settles a point.

## Review body

The engine builds the body from parts: `verdict` (what blocks and why, or
"Nothing blocks."), `answers` to the author's questions, an `index` of the
inline comments by theme, `praise` (1 or 2 specific lines, if earned) and
`body` (items that cannot go inline, never what the PR does; on a later pass,
if the author's replies check out). Retract a wrong earlier finding of ours in
`corrections`. Never write the pass line, locations, open points or seats.

## Replies

Start with the position: agree, disagree, or a question. Give one reason
and one example. When you agree, say what will change. No apology.
