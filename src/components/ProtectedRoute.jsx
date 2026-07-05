const { authed, loading } = useAuth();

if (loading) return <Loading />;

return authed ? <Dashboard /> : <Navigate to="/login" />;
