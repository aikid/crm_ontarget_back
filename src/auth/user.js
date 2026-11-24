function publicUser(user) {
  return {
    id: user.id,
    clientId: user.clientId,
    storeId: user.storeId,
    name: user.name,
    email: user.email,
    initials: user.initials,
    role: user.role,
    sellerOption: user.sellerOption,
    mustChangePassword: user.mustChangePassword,
    active: user.active,
    client: user.client || null,
  };
}

module.exports = { publicUser };
