// Shared by every branch-scoped route. A user is "branch scoped" if they
// have a branch_id at all — that covers branch admins and every other
// staff role (doctor/nurse/receptionist), who each belong to exactly one
// branch. A general admin has branch_id === null and is NOT scoped — they
// see and manage every branch, which is the whole point of the role.
//
// Usage in a route, alongside whatever WHERE-building convention that
// route already uses:
//
//   if (isBranchScoped(req)) {
//     conditions.push(`branch_id = $${i++}`);
//     values.push(req.user.branch_id);
//   }
//
// Deliberately just this one function rather than a query-builder — the
// route files in this app each have their own convention for building
// conditions/values arrays, and forcing a single abstraction on all of
// them would fight that more than it would help.
function isBranchScoped(req) {
  return req.user.branch_id !== null && req.user.branch_id !== undefined;
}

module.exports = { isBranchScoped };
