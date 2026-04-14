import { supabase } from './supabase-client.js';

let currentUser = null;
let currentStaff = null;

async function getSession() {
    const { data: { session } } = await supabase.auth.getSession();
    return session;
}

async function getStaffRecord(userId) {
    const { data, error } = await supabase
        .from('staff')
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

    const staff = await getStaffRecord(data.user.id);
    if (!staff) {
        await supabase.auth.signOut();
        throw new Error('No active staff record found for this account.');
    }

    currentUser = data.user;
    currentStaff = staff;
    return { user: data.user, staff };
}

async function signOut() {
    await supabase.auth.signOut();
    currentUser = null;
    currentStaff = null;
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

    const staff = await getStaffRecord(session.user.id);
    if (!staff) {
        await supabase.auth.signOut();
        window.location.href = 'index.html';
        return null;
    }

    if (allowedRoles && !allowedRoles.includes(staff.role)) {
        window.location.href = 'dashboard.html';
        return null;
    }

    currentUser = session.user;
    currentStaff = staff;
    return { user: session.user, staff };
}

function getCurrentStaff() {
    return currentStaff;
}

function getCurrentUser() {
    return currentUser;
}

function hasRole(...roles) {
    return currentStaff && roles.includes(currentStaff.role);
}

export {
    signIn,
    signOut,
    resetPassword,
    requireAuth,
    getCurrentStaff,
    getCurrentUser,
    hasRole
};
