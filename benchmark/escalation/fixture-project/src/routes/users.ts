router.get("/users", (req, res) => { const users = db.findAll(); res.json(users); });
