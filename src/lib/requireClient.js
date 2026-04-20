/**
 * Requires request.user.role === 'CLIENT'. Use after verifyJwt.
 */
export async function requireClient(request, reply) {
  if (request.user?.role !== 'CLIENT') {
    return reply.status(403).send({ message: 'Client access required' });
  }
}
