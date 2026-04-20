/**
 * Requires request.user.role === 'OWNER'. Use after verifyJwt.
 */
export async function requireOwner(request, reply) {
  if (request.user?.role !== 'OWNER') {
    return reply.status(403).send({ message: 'Admin access required' });
  }
}
