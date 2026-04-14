// Serves frontend config from Netlify environment variables
// This replaces the static config.js file for deployed environments

exports.handler = async () => {
    const js = `window.SUPABASE_URL = '${process.env.SUPABASE_URL || ''}';
window.SUPABASE_ANON_KEY = '${process.env.SUPABASE_ANON_KEY || ''}';`;

    return {
        statusCode: 200,
        headers: {
            'Content-Type': 'application/javascript',
            'Cache-Control': 'public, max-age=3600'
        },
        body: js
    };
};
