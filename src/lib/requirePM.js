/**
 * Requires request.user.role === 'PM' or 'OWNER'. Use after verifyJwt.
 */
export async function requirePM(request, reply) {
  const role = request.user?.role;
  if (role !== 'PM' && role !== 'OWNER') {
    return reply.status(403).send({ message: 'PM or Owner access required' });
  }
}
