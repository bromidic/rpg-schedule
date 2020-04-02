import { Client, GuildMember, Permissions, TextChannel, Guild } from "discord.js";
import express from "express";
import moment from "moment";
import request from "request";
import merge from "lodash/merge";
import cloneDeep from "lodash/cloneDeep";

import { Game, GameMethod, RescheduleMode, GameWhen, MonthlyType } from "../models/game";
import { GuildConfig } from "../models/guild-config";
import { Session } from "../models/session";
import config from "../models/config";
import aux from "../appaux";

interface APIRouteOptions {
  client: Client;
}

export default (options: APIRouteOptions) => {
  const router = express.Router();
  const client = options.client;

  router.use("/api", async (req, res, next) => {
    res.set("Access-Control-Allow-Origin", process.env.SITE_HOST);
    res.set("Access-Control-Allow-Methods", `GET,POST`);
    res.set("Access-Control-Allow-Headers", `authorization, accept, content-type`);
    try {
      const langs = req.app.locals.langs;
      const selectedLang = req.cookies.lang && langs.map(l => l.code).includes(req.cookies.lang) ? req.cookies.lang : "en";

      req.app.locals.lang = merge(cloneDeep(langs.find((lang: any) => lang && lang.code === "en")), cloneDeep(langs.find((lang: any) => lang && lang.code === selectedLang)));

      res.locals.lang = req.session.lang;
      // res.locals.urlPath = req._parsedOriginalUrl.pathname;
      res.locals.url = req.originalUrl;
      res.locals.env = process.env;

      moment.locale(req.app.locals.lang.code);

      next();
    } catch (err) {
      res.json({
        status: "error",
        code: 1,
        token: req.session.api && req.session.api.access.access_token,
        message: err.message || err
      });
    }
  });

  router.get("/api/login", async (req, res, next) => {
    if (req.query.code) {
      const headers = {
        "Content-Type": "application/x-www-form-urlencoded"
      };
      const requestData = {
        url: "https://discordapp.com/api/v6/oauth2/token",
        method: "POST",
        headers: headers,
        form: {
          client_id: process.env.CLIENT_ID,
          client_secret: process.env.CLIENT_SECRET,
          grant_type: "authorization_code",
          code: req.query.code,
          redirect_uri: `${process.env.SITE_HOST}/login`,
          scope: "identify guilds"
        }
      };

      request(requestData, async (error, response, body) => {
        if (error || response.statusCode !== 200) {
          return res.json({
            status: "error",
            code: 2,
            message: `Discord OAuth: ${response.statusCode}<br />${error}`,
            redirect: "/"
          });
        }

        const token = JSON.parse(body);
        req.session.api = {
          ...config.defaults.sessionStatus,
          ...req.session.api,
          ...{
            lastRefreshed: moment().unix()
          }
        };

        req.session.api.access = token;

        fetchAccount(token, {
          client: client,
          guilds: true
        })
          .then(async (result: any) => {
            const storedSession = await Session.fetch(token);
            if (storedSession) storedSession.delete();

            const d = new Date();
            d.setDate(d.getDate() + 14);
            const session = new Session({
              expires: d,
              token: token.access_token,
              session: {
                api: {
                  lastRefreshed: moment().unix(),
                  access: {
                    access_token: token.access_token,
                    refresh_token: token.refresh_token,
                    expires_in: token.expires_in,
                    scope: token.scope,
                    token_type: token.token_type
                  }
                }
              }
            });

            await session.save();
            aux.log("success", token.access_token);

            res.json({
              status: "success",
              token: token.access_token,
              account: result.account,
              redirect: config.urls.game.games.path
            });
          })
          .catch(err => {
            res.json({
              status: "error",
              code: 3,
              message: err,
              redirect: "/"
            });
          });
      });
    } else if (req.query.error) {
      res.json({
        status: "error",
        code: 4,
        message: req.query.error,
        redirect: "/"
      });
    } else {
      res.json({
        status: "error",
        code: 4,
        message: `OAuth2 code missing`,
        redirect: "/"
      });
    }
  });

  router.use("/auth-api", async (req, res, next) => {
    res.set("Access-Control-Allow-Origin", process.env.SITE_HOST);
    res.set("Access-Control-Allow-Methods", `GET,POST`);
    res.set("Access-Control-Allow-Headers", `authorization, accept, content-type`);

    const langs = req.app.locals.langs;
    const selectedLang = req.cookies.lang && langs.map(l => l.code).includes(req.cookies.lang) ? req.cookies.lang : "en";

    req.app.locals.lang = merge(cloneDeep(langs.find((lang: any) => lang.code === "en")), cloneDeep(langs.find((lang: any) => lang.code === selectedLang)));

    res.locals.lang = req.app.locals.lang;
    res.locals.url = req.originalUrl;
    res.locals.env = process.env;

    moment.locale(req.app.locals.lang.code);

    const bearer = (req.headers.authorization || "").replace("Bearer ", "").trim();

    if (!bearer || bearer.length == 0) {
      return res.json({
        status: "ignore"
      });
    }

    const storedSession = await Session.fetch(bearer);
    aux.log(storedSession, bearer);
    if (storedSession) req.session.api = storedSession.session.api;
    if (req.session.api) {
      const access = req.session.api.access;
      if (access.token_type) {
        // Refresh token
        const headers = {
          "Content-Type": "application/x-www-form-urlencoded"
        };

        // if (!req.session.api.lastRefreshed || req.session.api.lastRefreshed + 10 * 60 < moment().unix()) {
          const requestData = {
            url: "https://discordapp.com/api/v6/oauth2/token",
            method: "POST",
            headers: headers,
            form: {
              client_id: process.env.CLIENT_ID,
              client_secret: process.env.CLIENT_SECRET,
              grant_type: "refresh_token",
              refresh_token: access.refresh_token,
              redirect_uri: `${process.env.SITE_HOST}/login`,
              scope: "identify guilds"
            }
          };

          request(requestData, async (error, response, body) => {
            if (error || response.statusCode !== 200) {
              res.json({
                status: "error",
                message: `Discord OAuth: ${response.statusCode}<br />${error}`,
                redirect: "/"
              });
              return;
            }

            const token = JSON.parse(body);
            req.session.api = {
              ...config.defaults.sessionStatus,
              ...req.session.api,
              ...{
                lastRefreshed: moment().unix()
              }
            };
            req.session.api.access = token;

            aux.log(storedSession && storedSession.token, token.access_token);

            if (storedSession && storedSession.token != token.access_token) {
              await storedSession.delete();

              const d = new Date();
              d.setDate(d.getDate() + 14);
              const session = new Session({
                expires: d,
                token: token.access_token,
                session: {
                  api: {
                    lastRefreshed: moment().unix(),
                    access: {
                      access_token: token.access_token,
                      refresh_token: token.refresh_token,
                      expires_in: token.expires_in,
                      scope: token.scope,
                      token_type: token.token_type
                    }
                  }
                }
              });

              await session.save();
            }

            delete req.session.redirect;
            next();
          });
        // } else {
        //   next();
        // }
      } else {
        res.json({
          status: "error",
          token: req.session.api && req.session.api.access.access_token,
          message: "Missing or invalid session token (1)",
          redirect: "/"
        });
      }
    } else {
      res.json({
        status: "error",
        token: req.session.api && req.session.api.access.access_token,
        message: "Missing or invalid session token (2)",
        redirect: "/"
      });
    }
  });

  router.get("/auth-api/user", async (req, res, next) => {
    try {
      fetchAccount(req.session.api.access, {
        client: client
      })
        .then((result: any) => {
          res.json({
            status: "success",
            token: req.session.api.access.access_token,
            account: result.account
          });
        })
        .catch(err => {
          res.json({
            status: "error",
            token: req.session.api.access.access_token,
            message: `UserAuthError (1)`,
            redirect: "/"
          });
        });
    } catch (err) {
      res.json({
        status: "error",
        token: req.session.api.access.access_token,
        message: `UserAuthError (2)`
      });
    }
  });

  router.get("/auth-api/guilds", async (req, res, next) => {
    try {
      fetchAccount(req.session.api.access, {
        client: client,
        guilds: true,
        games: req.query.games,
        page: req.query.page
      })
        .then((result: any) => {
          res.json({
            status: "success",
            token: req.session.api.access.access_token,
            guilds: result.account.guilds
          });
        })
        .catch(err => {
          res.json({
            status: "error",
            token: req.session.api.access.access_token,
            message: `GuildsAPI: FetchAccountError: ${err}`,
            redirect: "/"
          });
        });
    } catch (err) {
      res.json({
        status: "error",
        token: req.session.api.access.access_token,
        message: `GuildsAPI: ${err}`
      });
    }
  });

  router.post("/auth-api/guild-config", async (req, res, next) => {
    try {
      fetchAccount(req.session.api.access, {
        client: client
      })
        .then(async (result: any) => {
          if (!req.body.id) throw new Error("Server configuration not found");
          const guildConfig = await GuildConfig.fetch(req.body.id);
          const guild = result.account.guilds.find(g => g.id == guildConfig.guild);
          if (!guild) throw new Error("Guild not found");
          if (!guild.isAdmin) throw new Error("You don't have permission to do that");
          for (const property in guildConfig) {
            if (req.body[property]) guildConfig[property] = req.body[property];
          }
          const saveResult = await guildConfig.save();

          const langs = req.app.locals.langs;
          const selectedLang = guildConfig.lang;
          const lang = merge(cloneDeep(langs.find((lang: any) => lang.code === "en")), cloneDeep(langs.find((lang: any) => lang.code === selectedLang)));

          res.json({
            status: saveResult.modifiedCount > 0 ? "success" : "error",
            token: req.session.api.access.access_token,
            guildConfig: guildConfig.data,
            lang: lang
          });
        })
        .catch(err => {
          res.json({
            status: "error",
            token: req.session.api.access.access_token,
            message: err
          });
        });
    } catch (err) {
      res.json({
        status: "error",
        token: req.session.api.access.access_token,
        message: `SaveGuildConfigError: ${err.message || err}`
      });
    }
  });

  router.get("/api/game", async (req, res, next) => {
    try {
      let game: Game;
      let server: string = req.query.s;
      if (req.query.g) {
        game = await Game.fetch(req.query.g);
        if (game) {
          server = game.s;
        } else {
          throw new Error("Game not found");
        }
      }

      if (server) {
        let guild: Guild = client.guilds.cache.get(server);
        if (!guild) guild = client.guilds.resolve(server);

        if (guild) {
          let password: string;

          const guildConfig = await GuildConfig.fetch(guild.id);
          const guildMembers = await guild.members.fetch();

          const textChannels = <TextChannel[]>guild.channels.cache.array().filter(c => c instanceof TextChannel);
          const channels = guildConfig.channels.filter(c => guild.channels.cache.array().find(gc => gc.id == c)).map(c => guild.channels.cache.get(c));
          if (channels.length === 0 && textChannels.length > 0) channels.push(textChannels[0]);

          if (channels.length === 0) {
            throw new Error("Discord channel not found. Make sure your server has a text channel.");
          }

          let data: any = {
            title: req.query.g ? req.session.lang.buttons.EDIT_GAME : req.session.lang.buttons.NEW_GAME,
            guild: guild.name,
            channels: channels,
            s: server,
            c: channels[0].id,
            dm: "",
            adventure: "",
            runtime: "",
            where: "",
            reserved: "",
            description: "",
            minPlayers: 1,
            players: 7,
            method: GameMethod.AUTOMATED,
            customSignup: "",
            when: GameWhen.DATETIME,
            date: req.query.date || "",
            time: req.query.time || "",
            timezone: "",
            reminder: "0",
            hideDate: false,
            gameImage: "",
            frequency: "",
            monthlyType: MonthlyType.WEEKDAY,
            weekdays: [false, false, false, false, false, false, false],
            clearReservedOnRepeat: false,
            env: {
              REMINDERS: process.env.REMINDERS,
              RESCHEDULING: process.env.RESCHEDULING
            },
            is: {
              newgame: !req.query.g ? true : false,
              editgame: req.query.g ? true : false,
              locked: password ? true : false
            },
            password: password ? password : false,
            enums: {
              GameMethod: GameMethod,
              GameWhen: GameWhen,
              RescheduleMode: RescheduleMode,
              MonthlyType: MonthlyType
            },
            guildConfig: guildConfig,
            errors: {
              other: null,
              minPlayers: game && (isNaN(parseInt(game.minPlayers || "1")) || parseInt(game.minPlayers || "1") > parseInt(game.players || "0")),
              maxPlayers: game && (isNaN(parseInt(game.players || "0")) || parseInt(game.minPlayers || "1") > parseInt(game.players || "0")),
              dm:
                game &&
                !guildMembers.array().find(mem => {
                  return mem.user.tag === game.dm.trim().replace("@", "");
                }),
              reserved: game
                ? game.reserved
                    .replace(/@/g, "")
                    .split(/\r?\n/)
                    .filter(res => {
                      if (res.trim().length === 0) return false;
                      return !guildMembers.array().find(mem => mem.user.tag === res.trim());
                    })
                : []
            }
          };

          if (req.query.g) {
            data = { ...data, ...game, _guild: null, _channel: null };
          }

          res.json({
            status: "success",
            token: req.session.api.access.access_token,
            game: data
            // lang: req.session.lang
          });
        } else {
          throw new Error("Discord server not found");
        }
      } else {
        throw new Error("Discord server not specified");
      }
    } catch (err) {
      res.json({
        status: "error",
        token: req.session.api.access.access_token,
        message: err.message || err,
        redirect: "/"
      });
    }
  });

  router.post("/api/game", async (req, res, next) => {
    const token = req.session.api && req.session.api.access && req.session.api.access.access_token;

    try {
      const userId = (req.headers.authorization || "0").replace("Bearer ", "").trim();

      let game: Game;
      let server: string = req.query.s;
      if (req.query.g && !(req.body && req.body.copy)) {
        game = await Game.fetch(req.query.g);
        if (game) {
          server = game.s;
        } else {
          throw new Error("Game not found");
        }
      }

      if (req.method === "POST") {
        req.body.reserved = req.body.reserved.replace(/@/g, "");
        if (req.body.copy) {
          delete req.query.g;
          req.query.s = req.body.s;
          server = req.body.s;
        }
        if (req.query.s) {
          game = new Game(req.body);
        }
      }

      if (server) {
        let guild: Guild = client.guilds.cache.get(server);
        if (!guild) guild = client.guilds.resolve(server);

        if (guild) {
          let password: string;

          const guildConfig = await GuildConfig.fetch(guild.id);
          const guildMembers = await guild.members.fetch();
          const member = guildMembers.array().find(m => m.id == userId);
          if (!member) throw new Error("You are not a member of this server");
          const isAdmin =
            member.hasPermission(Permissions.FLAGS.MANAGE_GUILD) ||
            member.roles.cache.find(r => r.name.toLowerCase().trim() === (guildConfig.managerRole || "").toLowerCase().trim());
          if (guildConfig && member.user.tag !== config.author) {
            password = guildConfig.password;
            // A role is required to post on the server
            if (guildConfig.role && !isAdmin) {
              // Ensure user is logged in
              try {
                await fetchAccount(token, { client: client });
              } catch (err) {
                return res.json({
                  status: "error",
                  token: req.session.api && req.session.api.access.access_token,
                  message: `You must be logged in to post a game to ${guild.name}.`,
                  redirect: "/"
                });
              }
              if (member) {
                // User does not have the require role
                if (!member.roles.cache.find(r => r.name.toLowerCase().trim() === guildConfig.role.toLowerCase().trim())) {
                  throw new Error("You are either not logged in or are missing the role required for posting on this server.");
                }
              }
            }
          }

          const textChannels = <TextChannel[]>guild.channels.cache.array().filter(c => c instanceof TextChannel);
          const channels = guildConfig.channels.filter(c => guild.channels.cache.array().find(gc => gc.id == c)).map(c => guild.channels.cache.get(c));
          if (channels.length === 0 && textChannels.length > 0) channels.push(textChannels[0]);

          if (channels.length === 0) {
            throw new Error("Discord channel not found. Make sure your server has a text channel.");
          }

          let data: any = {
            title: req.query.g ? req.app.locals.lang.buttons.EDIT_GAME : req.app.locals.buttons.NEW_GAME,
            guild: guild.name,
            channels: channels,
            s: server,
            c: channels[0].id,
            dm: "",
            adventure: "",
            runtime: "",
            where: "",
            reserved: "",
            description: "",
            minPlayers: 1,
            players: 7,
            method: GameMethod.AUTOMATED,
            customSignup: "",
            when: GameWhen.DATETIME,
            date: req.query.date || "",
            time: req.query.time || "",
            timezone: "",
            reminder: "0",
            hideDate: false,
            gameImage: "",
            frequency: "",
            monthlyType: MonthlyType.WEEKDAY,
            weekdays: [false, false, false, false, false, false, false],
            clearReservedOnRepeat: false,
            env: process.env,
            is: {
              newgame: !req.query.g ? true : false,
              editgame: req.query.g ? true : false,
              locked: password ? true : false
            },
            password: password ? password : false,
            enums: {
              GameMethod: GameMethod,
              GameWhen: GameWhen,
              RescheduleMode: RescheduleMode,
              MonthlyType: MonthlyType
            },
            guildConfig: guildConfig,
            errors: {
              other: null,
              minPlayers: game && (isNaN(parseInt(game.minPlayers || "1")) || parseInt(game.minPlayers || "1") > parseInt(game.players || "0")),
              maxPlayers: game && (isNaN(parseInt(game.players || "0")) || parseInt(game.minPlayers || "1") > parseInt(game.players || "0")),
              dm:
                game &&
                !guildMembers.array().find(mem => {
                  return mem.user.tag === game.dm.trim().replace("@", "");
                }),
              reserved: game
                ? game.reserved
                    .replace(/@/g, "")
                    .split(/\r?\n/)
                    .filter(res => {
                      if (res.trim().length === 0) return false;
                      return !guildMembers.array().find(mem => mem.user.tag === res.trim());
                    })
                : []
            }
          };

          if (req.query.g) {
            data = { ...data, ...game };
          }

          if (req.method === "POST") {
            data = Object.assign(data, req.body);
          }

          if (req.method === "POST") {
            Object.entries(req.body).forEach(([key, value]) => {
              game[key] = value;
            });

            for (let i = 0; i < 7; i++) {
              game.weekdays[i] = req.body["weekday" + i] ? true : false; // have to manually re-set falses b/c form data isn't sent if the checkbox is not checked
            }
            data.weekdays = game.weekdays;

            game.hideDate = req.body["hideDate"] ? true : false;
            game.clearReservedOnRepeat = req.body["clearReservedOnRepeat"] ? true : false;

            game
              .save()
              .then(response => {
                res.json({
                  status: response.modified ? "success" : "error",
                  token: token,
                  game: data,
                  _id: response.modified ? response._id : null
                });
              })
              .catch(err => {
                if (err.message.startsWith("DM")) {
                  data.errors.dm = err.message;
                } else {
                  data.errors.other = err.message;
                }
                res.json({
                  status: "error",
                  token: token,
                  game: data
                });
              });
          } else {
            res.json({
              status: "error",
              token: token,
              game: data
            });
          }
        } else {
          throw new Error("Discord server not found");
        }
      } else {
        throw new Error("Discord server not specified");
      }
    } catch (err) {
      res.json({
        status: "error",
        token: token,
        redirect: "/error",
        error: err.message || err
      });
    }
  });

  return router;
};

enum GamesPages {
  upcoming = "upcoming",
  myGames = "my-games",
  calendar = "calendar",
  server = "server"
}

interface AccountOptions {
  client: Client;
  guilds?: Boolean;
  games?: Boolean;
  page?: GamesPages;
}

const fetchAccount = async (token: any, options: AccountOptions) => {
  const client = options.client;

  return await new Promise((resolve, reject) => {
    const requestData = {
      url: "https://discordapp.com/api/users/@me",
      method: "GET",
      headers: {
        authorization: `${token.token_type} ${token.access_token}`
      }
    };

    request(requestData, async (error, response, body) => {
      try {
        // console.log(requestData, response.statusCode);
        if (!error && response.statusCode === 200) {
          const response = JSON.parse(body);
          const { username, discriminator, id, avatar } = response;
          const tag = `${username}#${discriminator}`;

          const account = {
            user: {
              ...response,
              ...{
                tag: tag,
                avatarURL: `https://cdn.discordapp.com/avatars/${id}/${avatar}.png?size=128`
              }
            },
            guilds: []
          };

          if (options.guilds) {
            client.guilds.cache.forEach(guild => {
              guild.members.cache.forEach(member => {
                if (member.id === id) {
                  account.guilds.push({
                    id: guild.id,
                    name: guild.name,
                    icon: guild.iconURL,
                    permission: false,
                    isAdmin: false,
                    member: member,
                    channels: guild.channels,
                    announcementChannels: [],
                    config: new GuildConfig({ guild: guild.id }),
                    games: []
                  });
                }
              });

              account.guilds = account.guilds.filter(guild => !guild.config.hidden || config.author == tag);
            });

            const guildConfigs = await GuildConfig.fetchAllBy({
              guild: {
                $in: account.guilds.reduce((i, g) => {
                  i.push(g.id);
                  return i;
                }, [])
              }
            });

            account.guilds = account.guilds.map(guild => {
              const guildConfig = guildConfigs.find(gc => gc.guild === guild.id) || new GuildConfig({ guild: guild.id });
              const member: GuildMember = guild.member;

              const textChannels = <TextChannel[]>guild.channels.cache.array().filter(c => c instanceof TextChannel);
              const channels = guildConfig.channels.filter(c => guild.channels.cache.array().find(gc => gc.id == c)).map(c => guild.channels.cache.get(c));
              if (channels.length === 0 && textChannels.length > 0) channels.push(textChannels[0]);
              guild.announcementChannels = channels;

              guild.permission = guildConfig.role ? !!member.roles.cache.find(r => r.name.toLowerCase().trim() === (guildConfig.role || "").toLowerCase().trim()) : true;
              guild.isAdmin =
                member.hasPermission(Permissions.FLAGS.MANAGE_GUILD) ||
                member.roles.cache.find(r => r.name.toLowerCase().trim() === (guildConfig.managerRole || "").toLowerCase().trim());
              guild.config = guildConfig;
              return guild;
            });

            if (options.page === GamesPages.server) {
              account.guilds = account.guilds.filter(g => account.guilds.find(s => s.id === g.id && (s.isAdmin || config.author == tag)));
            }

            if (options.games) {
              const gameOptions: any = {
                s: {
                  $in: account.guilds.reduce((i, g) => {
                    i.push(g.id);
                    return i;
                  }, [])
                }
              };

              if (options.page === GamesPages.myGames) {
                gameOptions.$or = [
                  {
                    dm: tag
                  },
                  {
                    reserved: {
                      $regex: tag.replace(/[-\/\\^$*+?.()|[\]{}]/g, "\\$&")
                    }
                  }
                ];
              }

              if (options.page === GamesPages.upcoming) {
                gameOptions.timestamp = {
                  $gt: new Date().getTime()
                };
                if (tag !== config.author) {
                  gameOptions.dm = {
                    $ne: tag
                  };
                }
              }

              const games: any[] = await Game.fetchAllBy(gameOptions);
              games.forEach(game => {
                if (!game.discordGuild) return;

                const date = Game.ISOGameDate(game);
                game.moment = {
                  raw: `${game.date} ${game.time} UTC${game.timezone < 0 ? "-" : "+"}${Math.abs(game.timezone)}`,
                  isoutc: `${new Date(`${game.date} ${game.time} UTC${game.timezone < 0 ? "-" : "+"}${Math.abs(game.timezone)}`)
                    .toISOString()
                    .replace(/[^0-9T]/gi, "")
                    .slice(0, 13)}00Z`,
                  iso: date,
                  date: moment(date)
                    .utcOffset(parseInt(game.timezone))
                    .format(config.formats.dateLong),
                  calendar: moment(date)
                    .utcOffset(parseInt(game.timezone))
                    .calendar(),
                  from: moment(date)
                    .utcOffset(parseInt(game.timezone))
                    .fromNow()
                };

                game.slot = game.reserved.split(/\r?\n/).findIndex(t => t.trim().replace("@", "") === tag) + 1;
                game.signedup = game.slot > 0 && game.slot <= parseInt(game.players);
                game.waitlisted = game.slot > parseInt(game.players);

                const gi = account.guilds.findIndex(g => g.id === game.s);
                account.guilds[gi].games.push(game);
              });
            }

            account.guilds = account.guilds.map(guild => {
              guild.games.sort((a, b) => {
                return a.timestamp < b.timestamp ? -1 : 1;
              });
              return guild;
            });

            if (options.page === GamesPages.upcoming || options.page === GamesPages.myGames) {
              account.guilds.sort((a, b) => {
                if (a.games.length === 0 && b.games.length === 0) return a.name < b.name ? -1 : 1;
                if (a.games.length === 0) return 1;
                if (b.games.length === 0) return -1;

                return a.games[0].timestamp < b.games[0].timestamp ? -1 : 1;
              });
            }
          }

          resolve({
            status: "success",
            account: account
          });
        }
        throw new Error(error);
      } catch (err) {
        reject(err);
      }
    });
  });
};
