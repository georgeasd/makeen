/* eslint-disable class-methods-use-this */
import Joi from 'joi';
import { ObjectID as objectId } from 'mongodb';
import jwt from 'jsonwebtoken';
import pick from 'lodash/pick';
import bcrypt from 'bcryptjs';
import moment from 'moment';
import { decorators, ServiceContainer } from 'octobus.js';
import crypto from 'crypto';
import ForgotPasswordTemplaate from '../mailerTemplates/ForgotPassword';
import UserSignupTemplate from '../mailerTemplates/UserSignup';
import { FailedLogin } from '../libs/errors';

const { service, withSchema } = decorators;

class User extends ServiceContainer {
  constructor(options) {
    super(options);
    this.jwtConfig = options.jwtConfig;
  }

  setServiceBus(serviceBus) {
    super.setServiceBus(serviceBus);
    this.UserRepository = serviceBus.extract('UserRepository');
    this.AccountRepository = serviceBus.extract('AccountRepository');
    this.Mail = serviceBus.extract('mailer.Mail');
  }

  @service()
  @withSchema({
    user: Joi.object().keys({
      id: Joi.string().required(),
      accountId: Joi.object(),
      username: Joi.string().required(),
      scope: Joi.array().default([]),
    }),
    options: Joi.object().default({}),
  })
  createToken({ options, user }) {
    return jwt.sign(user, this.jwtConfig.key, {
      ...this.jwtConfig.options,
      ...options,
    });
  }

  @service()
  @withSchema({
    username: Joi.string().required(),
    password: Joi.string().required(),
  })
  async login({ username, password }, { extract }) {
    const UserRepository = extract('UserRepository');
    const AccountRepository = extract('AccountRepository');
    const user = await UserRepository.findOne({
      query: {
        $or: [
          {
            username,
          },
          {
            email: username,
          },
        ],
      },
    });

    if (!user) {
      throw new FailedLogin('User not found!');
    }

    const account = await AccountRepository.findById(user.accountId);

    await this.canLogin({ user, account });

    const isValidPassword = await this.checkPassword({ user, password });
    if (!isValidPassword) {
      throw new FailedLogin('Incorrect password!');
    }

    return this.tryLogin(user);
  }

  @service()
  async canLogin({ user, account }) {
    if (!account) {
      throw new FailedLogin('Unable to find user account!');
    }

    if (user.labels.includes('isDeleted')) {
      throw new FailedLogin('User not found!');
    }

    if (!user.labels.includes('isActive')) {
      throw new FailedLogin('User is not active!');
    }

    if (!account.labels.includes('isConfirmed')) {
      throw new FailedLogin('Account is not confirmed!');
    }

    if (!account.labels.includes('isActive')) {
      throw new FailedLogin('Account is not active!');
    }

    return account;
  }

  @service()
  async checkPassword({ password, user }) {
    const hashedPassword = await this.hashPassword({
      password,
      salt: user.salt,
    });

    return user.password === hashedPassword;
  }

  @service()
  async tryLogin(user, { extract }) {
    const UserRepository = extract('UserRepository');
    const updatedUser = await UserRepository.replaceOne({
      ...user,
      lastLogin: new Date(),
    });

    const token = await this.createToken({
      user: await this.serialize(updatedUser),
    });

    return {
      ...updatedUser,
      token,
    };
  }

  @service()
  dump(data) {
    return pick(data, [
      'accountId',
      'username',
      'firstName',
      'lastName',
      'email',
      '_id',
      'updatedAt',
      'createdAt',
      'token',
      'labels',
      'lastLogin',
      'roles',
    ]);
  }

  @service()
  serialize(data) {
    return {
      id: data._id.toString(),
      username: data.username,
      accountId: data.accountId,
      scope: data.roles,
    };
  }

  @service()
  @withSchema({
    userId: Joi.object().required(),
    oldPassword: Joi.string().required(),
    password: Joi.string().required(),
  })
  async changePassword({ userId, oldPassword, password }) {
    const user = await this.UserRepository.findById(userId);

    if (!user) {
      throw new Error('User not found!');
    }

    const oldHashedPassword = await this.hashPassword({
      password: oldPassword,
      salt: user.salt,
    });

    if (oldHashedPassword !== user.password) {
      throw new Error('Invalid password!');
    }

    const hashedPassword = await this.hashPassword({
      password,
      salt: user.salt,
    });

    if (hashedPassword === user.password) {
      throw new Error("You can't use the same password!");
    }

    return this.UserRepository.updateOne({
      query: { _id: user._id },
      update: {
        $set: {
          resetPassword: {},
          password: hashedPassword,
        },
      },
    });
  }

  @service()
  @withSchema({
    password: Joi.string().required(),
    token: Joi.string().required(),
  })
  async recoverPassword({ password, token }) {
    const user = await this.UserRepository.findOne({
      query: {
        'resetPassword.token': token,
      },
    });

    if (!user) {
      throw new Error('Token not found!');
    }

    const hashedPassword = await this.hashPassword({
      password,
      salt: user.salt,
    });

    if (hashedPassword === user.password) {
      throw new Error("You can't use the same password!");
    }

    const updateResult = await this.UserRepository.updateOne({
      query: { _id: user._id },
      update: {
        $set: {
          resetPassword: {},
          password: hashedPassword,
        },
      },
    });

    return {
      user,
      updateResult,
    };
  }

  @service()
  async signup({ username, email }, { message }) {
    const existingUser = await this.UserRepository.findOne({
      query: {
        $or: [
          {
            username,
          },
          {
            email,
          },
        ],
      },
    });

    if (existingUser) {
      if (existingUser.username === username) {
        throw new Error('Username already taken.');
      }

      if (existingUser.email === email) {
        throw new Error('Email already taken.');
      }
    }

    const account = await this.AccountRepository.createOne({});

    const user = await this.UserRepository.createOne({
      accountId: account._id,
      ...message.data,
    });

    this.Mail.send({
      to: user.email,
      subject: 'welcome',
      template: UserSignupTemplate,
      context: {
        user,
        account,
      },
    });

    return {
      user: pick(user, [
        'accountId',
        '_id',
        'title',
        'firstName',
        'lastName',
        'email',
        'username',
        'roles',
        'labels',
        'createdAt',
        'updatedAt',
      ]),
      account: pick(account, ['labels', '_id', 'updatedAt', 'createdAt']),
    };
  }

  @service()
  async resetPassword(usernameOrEmail) {
    const user = await this.UserRepository.findOne({
      query: {
        $or: [
          {
            username: usernameOrEmail,
          },
          {
            email: usernameOrEmail,
          },
        ],
      },
    });

    if (!user) {
      throw new Error('User not found!');
    }

    const resetPassword = {
      token: crypto.randomBytes(20).toString('hex'),
      resetAt: new Date(),
    };

    const updateResult = await this.UserRepository.updateOne({
      query: { _id: user._id },
      update: {
        $set: { resetPassword },
      },
    });

    this.Mail.send({
      to: user.email,
      subject: 'forgot password',
      template: ForgotPasswordTemplaate,
      context: {
        user,
        resetPassword,
      },
    });

    return {
      user: {
        ...user,
        resetPassword,
      },
      updateResult,
    };
  }

  @service()
  async socialLogin({ provider, token, expiresIn, profile }) {
    if (provider === 'google') {
      Object.assign(profile, {
        id: profile.raw.sub,
      });
    }

    const user = await this.UserRepository.findOne({
      query: {
        $or: [
          {
            [`socialLogin.${provider}.id`]: profile.id,
          },
          {
            email: profile.email,
          },
        ],
      },
    });

    if (!user) {
      throw new Error('User not found!');
    }

    user.socialLogin[provider] = {
      id: profile.id,
      name: profile.displayName,
      email: profile.email,
      token,
      expiresAt: moment().add(expiresIn, 'seconds').toDate(),
    };

    const updatedUser = await this.UserRepository.replaceOne({
      ...user,
      lastLogin: new Date(),
    });

    const authToken = await this.createToken({
      id: user._id,
      username: user.username,
    });

    return {
      ...updatedUser,
      token: authToken,
    };
  }

  @service()
  hashPassword({ password, salt }) {
    return new Promise((resolve, reject) => {
      bcrypt.hash(password, salt, (err, result) => {
        if (err) {
          return reject(err);
        }

        return resolve(result);
      });
    });
  }

  validateJWT = (decodedToken, request, cb) => {
    if (!decodedToken || !decodedToken.id) {
      cb(null, false);
    } else {
      this.serviceBus
        .send('UserRepository.findById', objectId(decodedToken.id))
        .then(result => cb(null, !!result), cb);
    }
  };
}

export default User;
