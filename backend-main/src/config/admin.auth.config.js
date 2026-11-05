import bcrypt from "bcryptjs";
import moment from "moment";
import Credentials from "@auth/express/providers/credentials";
import { ExpressAuth, CredentialsSignin } from "@auth/express";
import { signToken } from "../utils/index.js";

import { env } from './index.js';
import { db } from "./index.js";

const collection = 'admins';
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
    callbacks: {
        async redirect({ url }) {
            return url;
        },
        async jwt({ token, user }) {
            if (user) {
                token.id = user.id;
                token.role = user.role;
                token.accessToken = user.accessToken;
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
            name: `${env.APP_NAME?.toLowerCase().replace(/\s+/g, '-')}.admin.session-token`,
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
    basePath: '/api/v1/admin/auth',
    debug: env.APP_ENV === 'development',
};

export { config as adminAuthConfig };
export const adminAuthHandler = ExpressAuth(config);
