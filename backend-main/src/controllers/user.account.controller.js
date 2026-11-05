import * as service from '../services/user.account.service.js';
import { brokerManager } from '../brokers/index.js';
import { errors } from '../utils/index.js';

export const getUserAccounts = async (req, res, next) => {
    try {
        const userId = req.user.id;
        const accounts = await service.getUserAccountsByUserId(userId);

        res.status(200).json({
            status: 'success',
            data: accounts,
        });
    } catch (error) {
        next(error);
    }
};

export const createUserAccount = async (req, res, next) => {
    try {
        const userId = req.user.id;
        const { accountType = 'futures', network = 'testnet' } = req.body;
        const accountData = { ...req.body, userId, accountType, network };
        const account = await service.createUserAccount(accountData);

        res.status(201).json({
            status: 'success',
            data: account,
        });
    } catch (error) {
        next(error);
    }
};

export const updateUserAccount = async (req, res, next) => {
    try {
        const { id } = req.params;
        const userId = req.user.id;

        const existingAccount = await service.getUserAccountById(id);
        if (!existingAccount) {
            throw errors.notFound('Account not found');
        }

        if (existingAccount.userId !== userId) {
            throw errors.forbidden('You do not have permission to update this account');
        }

        const updatedAccount = await service.updateUserAccount(id, req.body);
        res.status(200).json({
            status: 'success',
            data: updatedAccount,
        });
    } catch (error) {
        next(error);
    }
};

export const toggleUserAccountConnection = async (req, res, next) => {
    try {
        const { id } = req.params;
        const { connected } = req.body;
        const userId = req.user.id;

        const existingAccount = await service.getUserAccountById(id);
        if (!existingAccount) {
            throw errors.notFound('Account not found');
        }

        if (existingAccount.userId !== userId) {
            throw errors.forbidden('You do not have permission to toggle this account');
        }

        const updatedAccount = await service.updateUserAccount(id, { connected });

        res.status(200).json({
            status: 'success',
            data: updatedAccount,
        });
    } catch (error) {
        next(error);
    }
};

export const deleteUserAccount = async (req, res, next) => {
    try {
        const { id } = req.params;
        const userId = req.user.id;

        const existingAccount = await service.getUserAccountById(id);
        if (!existingAccount) {
            throw errors.notFound('Account not found');
        }

        if (existingAccount.userId !== userId) {
            throw errors.forbidden('You do not have permission to delete this account');
        }

        await service.deleteUserAccount(id);

        res.status(204).json({
            status: 'success',
            data: null,
        });
    } catch (error) {
        next(error);
    }
};

export const pingUserAccount = async (req, res, next) => {
    try {
        const {
            apiKey,
            apiSecret,
            exchangeType = 'binance',
            network = 'testnet',
            accountType = 'futures'
        } = req.query;

        const credentials = { apiKey, apiSecret };
        const isTestnet = network === 'testnet';

        // CCXT handles testnet via sandbox mode; no need for URL configs
        const result = await brokerManager.ping(exchangeType, credentials, isTestnet);

        res.status(200).json({
            status: 'success',
            data: result
        });
    } catch (error) {
        next(error);
    }
};