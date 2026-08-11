# The Ranking Covenant

Northstar exists on one promise: **results cannot be bought.**

## What ranks a page

Every signal is earned relevance. The complete list is public at `GET /v1/ranking`:

1. **Text relevance (BM25F)** — how well the page's words match the query.
   Title matches weigh 3×, description 1.5×, body 1×. Rare words count more
   than common ones.
2. **Phrase proximity** — query words appearing together, in order, beat the
   same words scattered across the page.
3. **Link authority (PageRank)** — pages that other indexed pages choose to
   link to earn authority. Only other sites can grant it.
4. **Freshness** — a small boost for recently updated pages.

## What can never rank a page

- Payment of any kind. There are no sponsored results, no paid placement,
  no auctions. Not "clearly labeled ads" — none.
- Advertising relationships. The engine runs no ads, so there are none to favor.
- Commercial partnerships with the sites being ranked.
- The political viewpoint of a page or its publisher.

## How this is enforced, not just promised

- **There is no code path for it.** The scoring function in
  `src/core/ranker.js` reads only the signals above. No field on a document,
  an account, or a request can add money to the equation, because no such
  field exists anywhere in the system.
- **A test pins it.** `test/ranker.test.js` injects sponsorship-style fields
  (`sponsored`, `adBudget`, `paidBoost`, `partnerTier`) onto every document
  and asserts that every score is bit-for-bit identical. If anyone ever wires
  money into ranking, CI goes red.
- **The formula is public API.** `GET /v1/ranking` publishes the signals and
  this exclusion list, so users can audit the promise at any time.
- **Every result shows its receipt.** Each search hit carries a `why` object
  explaining, in plain language and in numbers, exactly which signals put it
  on the page — so the promise is verifiable one result at a time.

## Why the business model makes this possible

Advertising-funded search serves two customers with opposite interests.
This engine is **subscription-funded**: the person searching is the only
customer, so being maximally useful to them is the entire business.
Revenue comes from `POST /v1/subscribe` — never from the results page.
