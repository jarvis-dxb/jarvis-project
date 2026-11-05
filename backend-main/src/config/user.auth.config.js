import bcrypt from "bcryptjs";
import moment from "moment";
import Credentials from "@auth/express/providers/credentials";
import { ExpressAuth, CredentialsSignin } from "@auth/express";
import { signToken, verifyToken } from "../utils/index.js";

import { env } from './index.js';
import { db } from "./index.js";

import { startSessionWatcher, stopSessionWatcher } from '../services/watcher-session.service.js';

const collection = 'users';
const throwAuthError = (err) => {
    const error = new CredentialsSignin();
    error.code = err;
    throw error;
};

const config = {
    providers: [
        Credentials({
            credentials: {
                email: { label: "Email", type: "email" },
                password: { label: "Password", type: "password" },
            },
            async authorize(credentials) {
                if (!credentials?.email || !credentials?.password) {
                    throwAuthError("MissingCredentials");
                }

                // Query the collection by email
                const usersRef = db.collection(collection);
                const snapshot = await usersRef.where("email", "==", credentials.email).limit(1).get();

                if (snapshot.empty) {
                    throwAuthError("EmailNotFound");
                }

                const userDoc = snapshot.docs[0];
                const userData = userDoc.data();

                // Verify password
                const isPasswordCorrect = await bcrypt.compare(
                    credentials.password,
                    userData.password
                );

                if (!isPasswordCorrect) {
                    throwAuthError("InvalidPassword");
                }

                if (!userData.verified) {
                    throwAuthError("EmailNotVerified");
                }

                // Return user object
                return {
                    id: userDoc.id,
                    name: userData.name,
                    email: userData.email,
                    role: userData.role,
                    accessToken: signToken({
                        id: userDoc.id,
                        email: userData.email,
                        role: userData.role
                    }),
                };
            },
        }),
    ],
    events: {
        async signIn({ user }) {
            void startSessionWatcher(user.id, { signedIn: true })
                .catch(() => console.warn('[Watcher] Could not start after sign-in'));
        },
        async signOut({ token }) {
            await stopSessionWatcher(token?.id)
                .catch(() => console.warn('[Watcher] Could not stop after sign-out'));
        },
    },
    callbacks: {
        async redirect({ url }) {
            return url;
        },
        async jwt({ token, user }) {
            if (user) {
                token.id = user.id;
                token.role = user.role;
                token.accessToken = user.accessToken;
            } else if (token?.id) {
                // Auth.js has already verified the encrypted login session. Its
                // short-lived API token can expire before that session does.
                const access = verifyToken(token.accessToken);
                if (!access || String(access.id) !== String(token.id)
                    || Number(access.exp) <= Math.floor(Date.now() / 1000) + 60) {
                    const owner = await db.collection(collection).doc(String(token.id)).get();
                    if (!owner.exists || !owner.data().verified) return null;
                    const current = owner.data();
                    token.role = current.role;
                    token.accessToken = signToken({
                        id: String(token.id), email: current.email, role: current.role,
                    });
                }
            }
            return token;
        },
        async session({ session, token }) {
            if (token) {
                session.user.id = token.id;
                session.user.role = token.role;
                session.accessToken = token.accessToken;
            }
            return session;
        },
    },
    session: {
        strategy: "jwt",
        maxAge: moment.duration(env.JWT_ACCESS_EXPIRE_IN_MINUTES, 'minutes').asSeconds(),
        updateAge: moment.duration(env.JWT_REFRESH_EXPIRE_IN_HOURS, 'hours').asSeconds(),
    },
    cookies: {
        sessionToken: {
            name: `${env.APP_NAME?.toLowerCase().replace(/\s+/g, '-')}.user.session-token`,
            options: {
                httpOnly: true,
                sameSite: env.APP_ENV === 'production' ? 'none' : 'lax',
                path: '/',
                secure: env.APP_ENV === 'production',
            },
        },
    },
    logger: {
        error(code, metadata) {
            if (code.type === "CredentialsSignin") return;
        },
        warn(code) {
        },
        debug(code, metadata) {
        },
    },
    secret: env.AUTH_SECRET,
    trustHost: true,
    skipCSRFCheck: true,
    basePath: '/api/v1/user/auth',
    debug: env.APP_ENV === 'development',
};

export { config as userAuthConfig };
export const userAuthHandler = ExpressAuth(config);
