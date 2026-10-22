## Summary

<!-- What problem does this change solve? Keep this focused. -->

## Related issue(s)

<!-- Use a closing keyword for every issue fully resolved by this PR. -->
Closes #

## Changes

- 

## Validation

- [ ] Tests added or updated where behavior changed
- [ ] Relevant checks run locally or the reason they were not run is documented
- [ ] CI/install changes use least privilege and pinned dependencies/actions
- [ ] Security-sensitive changes received an appropriate review

## Test run

- [ ] I ran the relevant tests locally and they pass (paste the command and result below)
- [ ] `node --check` passes for any `.js` files I touched
- [ ] The backend boots with `NODE_ENV=test node -e "require('./backend/src/app')"`
- [ ] No `truncated N chars` placeholder markers were introduced

```
# command(s) run and result
```

## Deployment and rollback

<!-- Note migrations, environment variables, image tags/digests, or rollback steps. Write “None” if not applicable. -->

## Scope

- [ ] This PR addresses a single issue (payments/auth changes are one issue per PR)
- [ ] I did not bundle unrelated fixes

## Checklist

- [ ] I searched for duplicate issues and PRs.
- [ ] I removed secrets, credentials, and personal/payment data from the change.
- [ ] Documentation is updated where user or operator behavior changed.
- [ ] This PR contains one focused change or clearly explains why the changes must ship together.
