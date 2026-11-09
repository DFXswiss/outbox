# Contributing

## Testing is mandatory, and it is automated

A change counts as tested only when fully automated tests have passed on your own machine. Manual checks do not count: clicking through pages, calling endpoints by hand or looking at screenshots is not testing.

### 1. The whole service runs locally

The test setup starts the complete Outbox service on your machine, as a real process with a real database and real HTTP, and drives every user flow automatically:

- sign-in for composers and approvers
- compose, check and submit a post
- approve and reject
- publish, including images
- retry and resolve

One command runs all of it, `npm run test:e2e`, and the README explains how to set it up.

### 2. Real counterparts, not invented ones

Every external system the service talks to is reached in its real form during the end-to-end run:

- **DFX API:** a locally running instance of the DFX API. Users sign in through it and the service receives tokens issued by it. Hand-written tokens or hand-written response bodies do not count.
- **X API:** a dedicated X test account. Its credentials stay on your machine and are never committed.

Unit tests may use stand-ins, but their data must be copied from the real system, with the source named next to it. Stand-ins never replace the end-to-end run.

If a counterpart does not exist yet, for example an API endpoint that has not been built, the feature that depends on it is not finished. The pull request says so plainly and does not present it as working.

### 3. Before every push

Run all of these locally on the commit you are about to push, and push only when all are green:

- `npm run typecheck`
- `npm test`
- `npm run test:e2e`

CI repeats the checks, but green CI does not replace the local run.

### 4. In the pull request

The pull request description lists the commands you ran, the commit they ran on and the result. A pull request without this is not ready for review.

### 5. Bug fixes

Every bug fix comes with an automated test that fails without the fix and passes with it.
