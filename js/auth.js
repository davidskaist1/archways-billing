import { supabase } from './supabase-client.js';

let currentUser = null;
let currentAppUser = null;

async function getSession() {
    const { data: { session } } = await supabase.auth.getSession();
    return session;
}

async function getAppUser(userId) {
    const { data, error } = await supabase
        .from('app_users')
        .select('*')
        .eq('auth_user_id', userId)
        .eq('is_active', true)
        .single();
    if (error) return null;
    return data;
}

async function signIn(email, password) {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw error;

    const appUser = await getAppUser(data.user.id);
    if (!appUser) {
        await supabase.auth.signOut();
        throw new Error('No active user account found. Contact your administrator.');
    }

    // Update last login (via SECURITY DEFINER RPC — bypasses RLS)
    await supabase.rpc('update_last_login');

    currentUser = data.user;
    currentAppUser = appUser;
    return { user: data.user, appUser };
}

async function signOut() {
    await supabase.auth.signOut();
    currentUser = null;
    currentAppUser = null;
    window.location.href = 'index.html';
}

async function resetPassword(email) {
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: window.location.origin + '/index.html'
    });
    if (error) throw error;
}

// Call on every protected page to ensure user is authenticated
async function requireAuth(allowedRoles = null) {
    const session = await getSession();
    if (!session) {
        window.location.href = 'index.html';
        return null;
    }

    const appUser = await getAppUser(session.user.id);
    if (!appUser) {
        await supabase.auth.signOut();
        window.location.href = 'index.html';
        return null;
    }

    if (allowedRoles && !allowedRoles.includes(appUser.role)) {
        window.location.href = 'dashboard.html';
        return null;
    }

    currentUser = session.user;
    currentAppUser = appUser;
    return { user: session.user, staff: appUser };
}

// Keep "getCurrentStaff" name for backwards compatibility with all page modules
function getCurrentStaff() {
    return currentAppUser;
}

function getCurrentUser() {
    return currentUser;
}

function hasRole(...roles) {
    return currentAppUser && roles.includes(currentAppUser.role);
}

export {
    signIn,
    signOut,
    resetPassword,
    requireAuth,
    getSession,
    getCurrentStaff,
    getCurrentUser,
    hasRole
};
