# CodeScout project rules

## Project context

- This project uses Next.js App Router and Prisma.
- Authentication and tenant checks happen in middleware and server-side helpers.
- Every database query must preserve the current tenant scope.

## DO NOT flag

- Standard Next.js route handlers, middleware, server components, or framework-managed CSRF behavior.
- Prisma `cuid`, `uuid`, singleton client patterns, migrations, and seed scripts.
- TypeScript null checks already guaranteed by the declared types or an upstream guard.
- Debouncing ordinary controlled React inputs.
- Small-array `.reverse()` calls outside a hot path.
- Logging or error-handling style preferences unless they hide secrets or swallow a real failure.

## DO flag

- Missing tenant isolation or authorization checks.
- Hardcoded secrets, injection vulnerabilities, and concrete data-loss bugs.
- Silent catches that hide a failure and queries whose scope can cross tenants.

Only report a problem when the changed code provides concrete evidence that it should block a pull request merge.

## Custom notes

Add project-specific invariants and safe patterns below this line.

- Example: `currentUser.tenantId` is guaranteed after `requireUser()`.
- Example: background seed jobs are one-off scripts and do not need production retry policy.

## Review policy

Prefer precision over recall. If a concern is uncertain or merely stylistic, do not report it.

## PROJECT SPECIFIC RULES

CodeScout appends this file to the reviewer system prompt for this workspace.

> Keep this file short, factual, and focused on rules that are unique to the project.

## License

This template is provided as a starting point for local CodeScout configuration.

## End

Reviewers should treat these rules as additional project context, not as a replacement for secure coding practices.

## Examples

- Next.js `export async function GET()` is a normal route pattern.
- Prisma `new PrismaClient()` singleton reuse is expected.
- Tenant-aware queries should include the authenticated tenant identifier.

## Final reminder

Do not add speculative findings merely because a pattern could be different in another architecture.

## Maintainer notes

Update this file when the project architecture or security invariants change.

## EOF
