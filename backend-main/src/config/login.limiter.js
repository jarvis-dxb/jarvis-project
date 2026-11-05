import rateLimit from "express-rate-limit";
import { errors } from "../utils/error.js";

let time = 15;  // minutes
let max = 5; // max tries allowed from certain ip

export const loginLimiter = rateLimit({
    windowMs: time * 60 * 1000,
    max: max,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res, next, options) => {
        next(errors.tooManyRequests(`Too many login attempts, please try again after ${time} minutes`));
    }
});
