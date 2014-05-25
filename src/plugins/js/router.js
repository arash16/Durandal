/**
 * Durandal 2.1.0 Copyright (c) 2012 Blue Spire Consulting, Inc. All Rights Reserved.
 * Available via the MIT license.
 * see: http://durandaljs.com or https://github.com/BlueSpire/Durandal for details.
 */
/*
 * Cleanup and re-design of hierarchical routers, By arash.shakery@gmail.com, May 2014
 */
/**
 * Connects the history module's url and history tracking support to Durandal's activation and composition engine allowing you to easily build navigation-style applications.
 * @module router
 * @requires system
 * @requires app
 * @requires activator
 * @requires events
 * @requires composition
 * @requires history
 * @requires knockout
 * @requires jquery
 */
define(['durandal/system', 'durandal/app', 'durandal/activator', 'durandal/events', 'durandal/composition', 'plugins/history', 'knockout', 'jquery'], function (system, app, activator, events, composition, history, ko, $) {
    var optionalParam = /\((.*?)\)/g;
    var namedParam = /(\(\?)?:\w+/g;
    var splatParam = /\*\w+/g;
    var escapeRegExp = /[\-{}\[\]+?.,\\\^$|#\s]/g;
    var startDeferred, rootRouter;
    var trailingSlash = /\/$/;
    var routesAreCaseSensitive = false;
    var contextRouter;
    var lastUrl;


    function routeStringToRegExp(routeString) {
        routeString = routeString.replace(escapeRegExp, '\\$&')
            .replace(optionalParam, '(?:$1)?')
            .replace(namedParam, function (match, optional) {
                return optional ? match : '([^\/]+)';
            })
            .replace(splatParam, '(.*?)');

        return new RegExp('^' + routeString + '$', routesAreCaseSensitive ? undefined : 'i');
    }

    function stripParametersFromRoute(route) {
        var colonIndex = route.indexOf(':');
        var length = colonIndex > 0 ? colonIndex - 1 : route.length;
        return route.substring(0, length);
    }

    function endsWith(str, suffix) {
        return str.indexOf(suffix, str.length - suffix.length) !== -1;
    }

    function compareArrays(first, second) {
        if (!first || !second) {
            return false;
        }

        if (first.length != second.length) {
            return false;
        }

        for (var i = 0, len = first.length; i < len; i++) {
            if (first[i] != second[i]) {
                return false;
            }
        }

        return true;
    }

    function reconstructUrl(instruction) {
        if (!instruction.queryString) {
            return instruction.fragment;
        }

        return instruction.fragment + '?' + instruction.queryString;
    }


    function toPromise(x) {
        if (x && x.then) return x;
        return system.defer(function (dfd2) { dfd2.resolve(x); });
    }

    var noOperation = toPromise(function () { return toPromise(true); });


    /**
     * @class Router
     * @uses Events
     */

    /**
     * Triggered when the navigation logic has completed.
     * @event router:navigation:complete
     * @param {object} instance The activated instance.
     * @param {object} instruction The routing instruction.
     * @param {Router} router The router.
     */

    /**
     * Triggered when the navigation has been cancelled.
     * @event router:navigation:cancelled
     * @param {object} instance The activated instance.
     * @param {object} instruction The routing instruction.
     * @param {Router} router The router.
     */

    /**
     * Triggered when navigation begins.
     * @event router:navigation:processing
     * @param {object} instruction The routing instruction.
     * @param {Router} router The router.
     */

    /**
     * Triggered right before a route is activated.
     * @event router:route:activating
     * @param {object} instance The activated instance.
     * @param {object} instruction The routing instruction.
     * @param {Router} router The router.
     */

    /**
     * Triggered right before a route is configured.
     * @event router:route:before-config
     * @param {object} config The route config.
     * @param {Router} router The router.
     */

    /**
     * Triggered just after a route is configured.
     * @event router:route:after-config
     * @param {object} config The route config.
     * @param {Router} router The router.
     */

    /**
     * Triggered when the view for the activated instance is attached.
     * @event router:navigation:attached
     * @param {object} instance The activated instance.
     * @param {object} instruction The routing instruction.
     * @param {Router} router The router.
     */

    /**
     * Triggered when the composition that the activated instance participates in is complete.
     * @event router:navigation:composition-complete
     * @param {object} instance The activated instance.
     * @param {object} instruction The routing instruction.
     * @param {Router} router The router.
     */

    /**
     * Triggered when the router does not find a matching route.
     * @event router:route:not-found
     * @param {string} fragment The url fragment.
     * @param {Router} router The router.
     */

    var createRouter = function () {
        var currentActivation,
            currentInstruction,
            activeItem = activator.create(),
            isProcessing = ko.observable(false);

        var router = {
            /**
             * The route handlers that are registered. Each handler consists of a `routePattern` and a `callback`.
             * @property {object[]} handlers
             */
            handlers: [],
            /**
             * The route configs that are registered.
             * @property {object[]} routes
             */
            routes: [],
            /**
             * The route configurations that have been designated as displayable in a nav ui (nav:true).
             * @property {KnockoutObservableArray} navigationModel
             */
            navigationModel: ko.observableArray([]),
            /**
             * The active item/screen based on the current navigation state.
             * @property {Activator} activeItem
             */
            activeItem: activeItem,
            /**
             * Indicates that the router (or a child router) is currently in the process of navigating.
             * @property {KnockoutComputed} isNavigating
             */
            isNavigating: ko.computed(function () {
                var current = activeItem();
                var processing = isProcessing();
                var currentRouterIsProcessing = current
                    && current.router
                    && current.router != router
                    && current.router.isNavigating() ? true : false;
                return  processing || currentRouterIsProcessing;
            }),
            /**
             * An observable surfacing the active routing instruction that is currently being processed or has recently finished processing.
             * The instruction object has `config`, `fragment`, `queryString`, `params` and `queryParams` properties.
             * @property {KnockoutObservable} activeInstruction
             */
            activeInstruction: ko.observable(null),
            __router__: true
        };


        events.includeIn(router);
        activeItem.settings.areSameItem = function (currentItem, newItem, currentActivationData, newActivationData) {
            return currentItem == newItem
                && compareArrays(currentActivationData, newActivationData);
        };


        // ------------------------------------------------------------------------------------------------------

        function hasChildRouter(instance) {
            return instance && instance.router && instance.router.__router__;
        }

        function getChildRouter(instance, parentRouter) {
            if (hasChildRouter(instance) && instance.router.parent == parentRouter)
                return instance.router;
            else {
                if (instance && system.isFunction(instance.getRouter)) {
                    var result,
                        params = router.activeInstruction().params,
                        args = [parentRouter];

                    if (params)
                        if (Array.isArray(params))
                            args.push.apply(args, params); else
                            args.push(params);

                    try {
                        contextRouter = router;
                        result = instance.getRouter.apply(instance, args);
                    } catch (error) {
                        system.log('ERROR: ' + error.message, error);
                        return;
                    }

                    return toPromise(result).then(function (rt) {
                        if (rt && rt.__router__ && rt.parent == parentRouter) return rt;
                    });
                }
            }
        }

        function setCurrentInstructionRouteIsActive(flag) {
            if (currentInstruction && currentInstruction.config.isActive) {
                currentInstruction.config.isActive(flag);
            }
        }

        function startNavigation(instruction) {
            system.log('Navigation Started', instruction);
            router.trigger('router:navigation:processing', instruction, router);
            router.activeInstruction(instruction);
        }

        function cancelNavigation(instruction) {
            system.log('Navigation Cancelled', instruction);

            router.activeInstruction(currentInstruction);
            router.trigger('router:navigation:cancelled', instruction, router);
        }

        function completeNavigation(instance, instruction) {
            var fromModuleId = system.getModuleId(currentActivation);
            if (fromModuleId) {
                router.trigger('router:navigation:from:' + fromModuleId);
            }

            currentActivation = instance;

            setCurrentInstructionRouteIsActive(false);
            currentInstruction = instruction;
            setCurrentInstructionRouteIsActive(true);

            var toModuleId = system.getModuleId(currentActivation);
            if (toModuleId) {
                router.trigger('router:navigation:to:' + toModuleId);
            }

            if (!hasChildRouter(instance, router)) {
                router.updateDocumentTitle(instance, instruction);
            }

            router.trigger('router:navigation:complete', instance, instruction, router);
            system.log('Navigation Complete', instance, instruction);
        }


        function activateRoute(activator, instance, instruction) {
            contextRouter = router;
            return activator.activateItem2(instance, instruction.params)
                .then(function (canContinueCb) {
                    return canContinueCb && function () {
                        router.trigger('router:route:activating', instance, instruction, router);
                        contextRouter = router;
                        return canContinueCb().then(function (success) {
                            if (!success) throw new Error('An unexpected error has occurred while activating.');

                            var previousActivation = currentActivation;
                            completeNavigation(instance, instruction);

                            if (previousActivation == instance) {
                                router.attached();
                                router.compositionComplete();
                            }

                            if (startDeferred) {
                                startDeferred.resolve();
                                startDeferred = null;
                            }
                        });
                    };
                });
        }

        /**
         * Inspects routes and modules before activation. Can be used to protect access by cancelling navigation or redirecting.
         * @method guardRoute
         * @param {object} instance The module instance that is about to be activated by the router.
         * @param {object} instruction The route instruction. The instruction object has config, fragment, queryString, params and queryParams properties.
         * @return {Promise|Boolean|String} If a boolean, determines whether or not the route should activate or be cancelled. If a string, causes a redirect to the specified route. Can also be a promise for either of these value types.
         */
        function handleGuardedRoute(activator, instance, instruction) {
            return toPromise(router.guardRoute(instance, instruction))
                .then(function (result) {
                    if (system.isString(result)) {
                        rootRouter.navigate(result);
                        return false;
                    }
                    return result && activateRoute(activator, instance, instruction);
                });
        }

        function ensureActivation(activator, instance, instruction) {
            if (router.guardRoute) {
                return handleGuardedRoute(activator, instance, instruction);
            } else {
                return activateRoute(activator, instance, instruction);
            }
        }

        function getChildRouterCanContinue(instance, fragment) {
            return toPromise(getChildRouter(instance, router))
                .then(function (childRouter) {
                    return (!childRouter && noOperation) || childRouter.loadFragment(fragment);
                });
        }

        function getInstructionCanContinue(instruction, reuse) {
            if (instruction.deactivate) {
                if (!currentActivation) return noOperation;
                contextRouter = router;
                return activeItem.canDeactivate(true).then(function (canDeactivate) {
                    return canDeactivate && function () {
                        contextRouter = router;
                        return activeItem.forceDeactivate(true).then(function (deactivated) {
                            if (!deactivated) throw new Error('An unexpected error has occurred while deactivating.');

                            setCurrentInstructionRouteIsActive(false);
                            currentActivation = currentInstruction = undefined;
                        });
                    };
                });
            }

            if (reuse) {
                var tempActivator = activator.create();
                tempActivator.forceActiveItem(currentActivation); //enforce lifecycle without re-compose
                tempActivator.settings.areSameItem = activeItem.settings.areSameItem;
                tempActivator.settings.closeOnDeactivate = false;
                return ensureActivation(tempActivator, currentActivation, instruction);
            }

            if (!instruction.config.moduleId) {
                return ensureActivation(activeItem, {
                    viewUrl: instruction.config.viewUrl,
                    canReuseForRoute: function () {
                        return true;
                    }
                }, instruction);
            }

            contextRouter = router;
            return system.acquire(instruction.config.moduleId).then(function (m) {
                contextRouter = router;
                var instance = system.resolveObject(m);

                if (instruction.config.viewUrl) {
                    instance.viewUrl = instruction.config.viewUrl;
                }

                return ensureActivation(activeItem, instance, instruction).then(function (canContinue) {
                    return canContinue && getChildRouterCanContinue(instance, reconstructUrl(instruction))
                        .then(function (childCb) {
                            return childCb && function () {
                                return canContinue().then(childCb);
                            };
                        });
                });
            });
        }

        function canReuseCurrentActivation(instruction) {
            if (!currentActivation || !currentInstruction || currentInstruction.config.moduleId != instruction.config.moduleId)
                return false;

            if (system.isFunction(currentActivation.canReuseForRoute)) {
                try {
                    contextRouter = router;
                    return currentActivation.canReuseForRoute.apply(currentActivation, instruction.params);
                }
                catch (error) {
                    system.log('ERROR: ' + error.message, error);
                    return false;
                }
            }

            return hasChildRouter(currentActivation) || system.isFunction(currentActivation.getRouter);
        }

        function processInstruction(instruction) {
            // Navigation starts
            startNavigation(instruction);

            // canReuseForRoute may return promise
            return toPromise(canReuseCurrentActivation(instruction))
                .then(function (canReuse) {

                    // If canReuse is false, any possible child router must deactivate, which what null fragment do.
                    var childFragment = canReuse ? reconstructUrl(instruction) : null;

                    // check canDeactivate and canActivates
                    return getChildRouterCanContinue(currentActivation, childFragment)
                        .then(function (childCb) {
                            return childCb && getInstructionCanContinue(instruction, canReuse)
                                .then(function (instructionCb) {
                                    return instructionCb && function () {
                                        return childCb().then(instructionCb);
                                    };
                                });
                        });

                })  // when navigation canceled.
                .then(function (canNavigate) {
                    return canNavigate || cancelNavigation(instruction);
                });
        }

        function processFragment(fragment) {
            if (fragment === null) return processInstruction({ deactivate: true, config: {} });

            var handlers = router.handlers,
                queryString = null,
                coreFragment = fragment,
                queryIndex = fragment.indexOf('?');

            if (queryIndex != -1) {
                coreFragment = fragment.substring(0, queryIndex);
                queryString = fragment.substr(queryIndex + 1);
            }

            if (router.relativeToParentRouter) {
                var instruction = router.parent.activeInstruction();
                coreFragment = queryIndex == -1 ? instruction.params.join('/') : instruction.params.slice(0, -1).join('/');

                if (coreFragment && coreFragment.charAt(0) == '/') {
                    coreFragment = coreFragment.substr(1);
                }

                if (!coreFragment) {
                    coreFragment = '';
                }

                coreFragment = coreFragment.replace('//', '/').replace('//', '/');
            }

            coreFragment = coreFragment.replace(trailingSlash, '');

            for (var i = 0; i < handlers.length; i++) {
                var current = handlers[i];
                if (current.routePattern.test(coreFragment))
                    return current.callback(coreFragment, queryString)
            }

            system.log('Route Not Found', fragment, currentInstruction);
            router.trigger('router:route:not-found', fragment, router);
        }


        var fragmentQueue = [];
        router.loadFragment = function (fragment) {
            if (isProcessing()) {
                return system.defer(function (dfd) {
                    if (fragmentQueue.length < 3)
                        fragmentQueue.push(dfd);
                    else
                        dfd.resolve(false);
                }).promise().then(function (x) {
                    return x && router.loadFragment(fragment);
                });
            }

            isProcessing(true);
            return toPromise(processFragment(fragment))
                .then(function (res) {
                    return system.isFunction(res) ? function () { return toPromise(res()); } : false;
                })
                .then(function (canContinue) {
                    if (!canContinue) {
                        dequeueNextFragment();
                    }

                    return canContinue && function () {
                        return canContinue()
                            .fail(function (error) {
                                dequeueNextFragment();
                                throw error;
                            });
                    };
                });
        };

        function dequeueNextFragment() {
            isProcessing(false);
            var dfd = fragmentQueue.shift();
            if (dfd) dfd.resolve(true);
        }

        router.attached = function () {
            router.trigger('router:navigation:attached', currentActivation, currentInstruction, router);
        };

        router.compositionComplete = function () {
            router.trigger('router:navigation:composition-complete', currentActivation, currentInstruction, router);
            dequeueNextFragment();
        };


        // ------------------------------------------------------------------------------------------------------

        /**
         * Add a route to be tested when the url fragment changes.
         * @method route
         * @param {RegEx} routePattern The route pattern to test against.
         * @param {function} callback The callback to execute when the route pattern is matched.
         */
        router.route = function (routePattern, callback) {
            router.handlers.push({ routePattern: routePattern, callback: callback });
        };


        function configureRoute(config) {
            router.trigger('router:route:before-config', config, router);

            if (!system.isRegExp(config.route)) {
                config.title = config.title || router.convertRouteToTitle(config.route);

                if (!config.viewUrl) {
                    config.moduleId = config.moduleId || router.convertRouteToModuleId(config.route);
                }

                config.hash = config.hash || router.convertRouteToHash(config.route);

                if (config.hasChildRoutes) {
                    config.route = config.route + '*childRoutes';
                }

                config.routePattern = routeStringToRegExp(config.route);
            } else {
                config.routePattern = config.route;
            }

            config.isActive = config.isActive || ko.observable(false);
            router.trigger('router:route:after-config', config, router);

            router.routes.push(config);
            router.route(config.routePattern, function (fragment, queryString) {
                var paramInfo = createParams(config.routePattern, fragment, queryString);
                return processInstruction({
                    fragment: fragment,
                    queryString: queryString,
                    config: config,
                    params: paramInfo.params,
                    queryParams: paramInfo.queryParams
                });
            });
        }

        function mapRoute(config) {
            if (system.isArray(config.route)) {
                var isActive = config.isActive || ko.observable(false);

                for (var i = 0, length = config.route.length; i < length; i++) {
                    var current = system.extend({}, config);

                    current.route = config.route[i];
                    current.isActive = isActive;

                    if (i > 0) {
                        delete current.nav;
                    }

                    configureRoute(current);
                }
            } else {
                configureRoute(config);
            }

            return router;
        }

        /**
         * Maps route patterns to modules.
         * @method map
         * @param {string|object|object[]} route A route, config or array of configs.
         * @param {object} [config] The config for the specified route.
         * @chainable
         * @example
         router.map([
         { route: '', title:'Home', moduleId: 'homeScreen', nav: true },
         { route: 'customer/:id', moduleId: 'customerDetails'}
         ]);
         */
        router.map = function (route, config) {
            if (system.isArray(route)) {
                for (var i = 0; i < route.length; i++) {
                    router.map(route[i]);
                }

                return router;
            }

            if (system.isString(route) || system.isRegExp(route)) {
                if (!config) {
                    config = {};
                } else if (system.isString(config)) {
                    config = { moduleId: config };
                }

                config.route = route;
            } else {
                config = route;
            }

            return mapRoute(config);
        };

        /**
         * Builds an observable array designed to bind a navigation UI to. The model will exist in the `navigationModel` property.
         * @method buildNavigationModel
         * @param {number} defaultOrder The default order to use for navigation visible routes that don't specify an order. The default is 100 and each successive route will be one more than that.
         * @chainable
         */
        router.buildNavigationModel = function (defaultOrder) {
            var nav = [], routes = router.routes;
            var fallbackOrder = defaultOrder || 100;

            for (var i = 0; i < routes.length; i++) {
                var current = routes[i];

                if (current.nav) {
                    if (!system.isNumber(current.nav)) {
                        current.nav = ++fallbackOrder;
                    }

                    nav.push(current);
                }
            }

            nav.sort(function (a, b) { return a.nav - b.nav; });
            router.navigationModel(nav);

            return router;
        };

        /**
         * Configures how the router will handle unknown routes.
         * @method mapUnknownRoutes
         * @param {string|function} [config] If not supplied, then the router will map routes to modules with the same name.
         * If a string is supplied, it represents the module id to route all unknown routes to.
         * Finally, if config is a function, it will be called back with the route instruction containing the route info. The function can then modify the instruction by adding a moduleId and the router will take over from there.
         * @param {string} [replaceRoute] If config is a module id, then you can optionally provide a route to replace the url with.
         * @chainable
         */
        router.mapUnknownRoutes = function (config, replaceRoute) {
            var catchAllRoute = "*catchall";
            var catchAllPattern = routeStringToRegExp(catchAllRoute);

            router.route(catchAllPattern, function (fragment, queryString) {
                var paramInfo = createParams(catchAllPattern, fragment, queryString);
                var instruction = {
                    fragment: fragment,
                    queryString: queryString,
                    config: {
                        route: catchAllRoute,
                        routePattern: catchAllPattern
                    },
                    params: paramInfo.params,
                    queryParams: paramInfo.queryParams
                };

                if (!config) {
                    instruction.config.moduleId = fragment;
                } else if (system.isString(config)) {
                    instruction.config.moduleId = config;
                    if (replaceRoute) {
                        history.navigate(replaceRoute, { trigger: false, replace: true });
                    }
                } else if (system.isFunction(config)) {
                    var result = config(instruction);
                    if (result && result.then) {
                        return result.then(function () {
                            router.trigger('router:route:before-config', instruction.config, router);
                            router.trigger('router:route:after-config', instruction.config, router);
                            return processInstruction(instruction);
                        });
                    }
                } else {
                    instruction.config = config;
                    instruction.config.route = catchAllRoute;
                    instruction.config.routePattern = catchAllPattern;
                }

                router.trigger('router:route:before-config', instruction.config, router);
                router.trigger('router:route:after-config', instruction.config, router);
                return processInstruction(instruction);
            });

            return router;
        };

        /**
         * Makes all configured routes and/or module ids relative to a certain base url.
         * @method makeRelative
         * @param {string|object} settings If string, the value is used as the base for routes and module ids. If an object, you can specify `route` and `moduleId` separately. In place of specifying route, you can set `fromParent:true` to make routes automatically relative to the parent router's active route.
         * @chainable
         */
        router.makeRelative = function (settings) {
            if (system.isString(settings)) {
                settings = {
                    moduleId: settings,
                    route: settings
                };
            }

            if (settings.moduleId && !endsWith(settings.moduleId, '/')) {
                settings.moduleId += '/';
            }

            if (settings.route && !endsWith(settings.route, '/')) {
                settings.route += '/';
            }

            if (settings.fromParent) {
                router.relativeToParentRouter = true;
            }


            // relative navigation is on when fromParent is set, can be set to false if needed.
            // for absolute-path navigation, developer may use rootRouter.
            router.relativeNavigation = settings.relativeNavigation
                || (settings.fromParent && settings.relativeNavigation !== false);


            router.on('router:route:before-config').then(function (config) {
                if (settings.moduleId) {
                    config.moduleId = settings.moduleId + config.moduleId;
                }

                if (settings.route) {
                    if (config.route === '') {
                        config.route = settings.route.substring(0, settings.route.length - 1);
                    } else {
                        config.route = settings.route + config.route;
                    }
                }
            });

            if (settings.dynamicHash) {
                router.on('router:route:after-config').then(function (config) {
                    config.routePattern = routeStringToRegExp(settings.dynamicHash + (config.route ? '/' + config.route : ''));
                    config.dynamicHash = config.dynamicHash || ko.observable(config.hash);
                });

                router.on('router:navigation:complete')
                    .then(function (instance, instruction, parentRouter) {
                        var childRouter = instance.router;
                        if (childRouter && childRouter.__router__ && childRouter.parent == parentRouter)
                            for (var i = 0; i < childRouter.routes.length; i++) {
                                var params = instruction.params.slice(0);
                                var route = childRouter.routes[i];
                                route.hash = childRouter.convertRouteToHash(route.route)
                                    .replace(namedParam, function (match) {
                                        return params.length > 0 ? params.shift() : match;
                                    });
                                route.dynamicHash(route.hash);
                            }
                    });
            }

            return router;
        };


        /**
         * Converts a route to a hash suitable for binding to a link's href.
         * @method convertRouteToHash
         * @param {string} route
         * @return {string} The hash.
         */
        router.convertRouteToHash = function (route) {
            route = route.replace(/\*.*$/, '');

            if (router.relativeToParentRouter) {
                var instruction = router.parent.activeInstruction(),
                    hash = route ? instruction.config.hash + '/' + route : instruction.config.hash;

                if (history._hasPushState) {
                    hash = '/' + hash;
                }

                hash = hash.replace('//', '/').replace('//', '/');
                return hash;
            }

            if (history._hasPushState) {
                return route;
            }

            return "#" + route;
        };

        /**
         * Converts a route to a module id. This is only called if no module id is supplied as part of the route mapping.
         * @method convertRouteToModuleId
         * @param {string} route
         * @return {string} The module id.
         */
        router.convertRouteToModuleId = function (route) {
            return stripParametersFromRoute(route);
        };

        /**
         * Converts a route to a displayable title. This is only called if no title is specified as part of the route mapping.
         * @method convertRouteToTitle
         * @param {string} route
         * @return {string} The title.
         */
        router.convertRouteToTitle = function (route) {
            var value = stripParametersFromRoute(route);
            return value.substring(0, 1).toUpperCase() + value.substring(1);
        };


        /**
         * Parses a query string into an object.
         * @method parseQueryString
         * @param {string} queryString The query string to parse.
         * @return {object} An object keyed according to the query string parameters.
         */
        router.parseQueryString = function (queryString) {
            var queryObject, pairs;

            if (!queryString) {
                return null;
            }

            pairs = queryString.split('&');

            if (pairs.length == 0) {
                return null;
            }

            queryObject = {};

            for (var i = 0; i < pairs.length; i++) {
                var pair = pairs[i];
                if (pair === '') {
                    continue;
                }

                var parts = pair.split(/=(.+)?/),
                    key = parts[0],
                    value = parts[1] && decodeURIComponent(parts[1].replace(/\+/g, ' '));

                var existing = queryObject[key];

                if (existing) {
                    if (system.isArray(existing)) {
                        existing.push(value);
                    } else {
                        queryObject[key] = [existing, value];
                    }
                }
                else {
                    queryObject[key] = value;
                }
            }

            return queryObject;
        };

        // Given a route, and a URL fragment that it matches, return the array of
        // extracted decoded parameters. Empty or unmatched parameters will be
        // treated as `null` to normalize cross-browser behavior.
        function createParams(routePattern, fragment, queryString) {
            var params = routePattern.exec(fragment).slice(1);

            for (var i = 0; i < params.length; i++) {
                var current = params[i];
                params[i] = current ? decodeURIComponent(current) : null;
            }

            var queryParams = router.parseQueryString(queryString);
            if (queryParams) {
                params.push(queryParams);
            }

            return {
                params: params,
                queryParams: queryParams
            };
        }

        /**
         * Updates the document title based on the activated module instance, the routing instruction and the app.title.
         * @method updateDocumentTitle
         * @param {object} instance The activated module.
         * @param {object} instruction The routing instruction associated with the action. It has a `config` property that references the original route mapping config.
         */
        router.updateDocumentTitle = function (instance, instruction) {
            var appTitle = ko.unwrap(app.title),
                title = instruction.config.title;

            if (titleSubscription) {
                titleSubscription.dispose();
            }

            if (title) {
                if (ko.isObservable(title)) {
                    titleSubscription = title.subscribe(setTitle);
                    setTitle(title());
                } else {
                    setTitle(title);
                }
            } else if (appTitle) {
                document.title = appTitle;
            }
        };
        var titleSubscription;

        function setTitle(value) {
            var appTitle = ko.unwrap(app.title);

            if (appTitle) {
                document.title = value + " | " + appTitle;
            } else {
                document.title = value;
            }
        }

        // Allow observable to be used for app.title
        if (ko.isObservable(app.title)) {
            app.title.subscribe(function () {
                var instruction = router.activeInstruction();
                var title = instruction != null ? ko.unwrap(instruction.config.title) : '';
                setTitle(title);
            });
        }


        // ------------------------------------------------------------------------------------------------------


        /**
         * Save a fragment into the hash history, or replace the URL state if the
         * 'replace' option is passed. You are responsible for properly URL-encoding
         * the fragment in advance.
         * The options object can contain `trigger: false` if you wish to not have the
         * route callback be fired, or `replace: true`, if
         * you wish to modify the current URL without adding an entry to the history.
         * @method navigate
         * @param {string} fragment The url fragment to navigate to.
         * @param {object|boolean} options An options object with optional trigger and replace flags. You can also pass a boolean directly to set the trigger option. Trigger is `true` by default.
         * @return {boolean} Returns true/false from loading the url.
         */
        router.navigate = function (fragment, options) {
            if (fragment && fragment.indexOf('://') != -1) {
                window.location.href = fragment;
                return true;
            }

            if (router.relativeNavigation) {
                var instruction = router.parent.activeInstruction();
                fragment = instruction.config.hash + (fragment ? '/' + fragment : '');
                fragment = fragment.replace('//', '/').replace('//', '/');
            }

            if (options === false || (options && options.trigger != undefined && !options.trigger)) {
                lastUrl = fragment;
            }

            return history.navigate(fragment, options);
        };


        /**
         * Navigates back in the browser history.
         * @method navigateBack
         */
        router.navigateBack = function () {
            history.navigateBack();
        };

        // ------------------------------------------------------------------------------------------------------


        /**
         * Resets the router by removing handlers, routes, event handlers and previously configured options.
         * @method reset
         * @chainable
         */
        router.reset = function () {
            currentInstruction = currentActivation = undefined;
            router.handlers = [];
            router.routes = [];
            router.off();
            delete router.options;
            return router;
        };

        /**
         * Creates a child router.
         * @method createChildRouter
         * @return {Router} The child router.
         */
        router.createChildRouter = function (parent) {
            var childRouter = createRouter();
            childRouter.parent = parent || contextRouter;
            return childRouter;
        };

        return router;
    };


    /**
     * @class RouterModule
     * @extends Router
     * @static
     */
    rootRouter = createRouter();


    /**
     * Attempt to load the specified URL fragment. If a route succeeds with a match, returns `true`. If no defined routes matches the fragment, returns `false`.
     * @method loadUrl
     * @param {string} fragment The URL fragment to find a match for.
     * @return {boolean} True if a match was found, false otherwise.
     */
    rootRouter.loadUrl = function (fragment) {
        return rootRouter.loadFragment(fragment)
            .then(function (canContinue) {
                if (!canContinue && typeof lastUrl == 'string')
                    history.navigate(lastUrl, { trigger: false, replace: true });

                return canContinue && canContinue()
                    .then(function () {
                        lastUrl = fragment;

                        // Make sure url is correct, it may have changed
                        history.navigate(fragment, { trigger: false, replace: true });
                    });
            })
            .fail(function (err) {
                rootRouter.navigate(lastUrl);
                system.log('Failure when navigating to: ' + fragment, err);
            });
    };


    /**
     * Makes the RegExp generated for routes case sensitive, rather than the default of case insensitive.
     * @method makeRoutesCaseSensitive
     */
    rootRouter.makeRoutesCaseSensitive = function () {
        routesAreCaseSensitive = true;
    };

    /**
     * Verify that the target is the current window
     * @method targetIsThisWindow
     * @return {boolean} True if the event's target is the current window, false otherwise.
     */
    rootRouter.targetIsThisWindow = function (event) {
        var targetWindow = $(event.target).attr('target');

        return  !targetWindow ||
            targetWindow === window.name ||
            targetWindow === '_self' ||
            (targetWindow === 'top' && window === window.top)
    };

    /**
     * Activates the router and the underlying history tracking mechanism.
     * @method activate
     * @return {Promise} A promise that resolves when the router is ready.
     */
    rootRouter.activate = function (options) {
        return system.defer(function (dfd) {
            startDeferred = dfd;
            rootRouter.options = system.extend({ routeHandler: rootRouter.loadUrl }, rootRouter.options, options);

            history.activate(rootRouter.options);

            if (history._hasPushState) {
                var routes = rootRouter.routes,
                    i = routes.length;

                while (i--) {
                    var current = routes[i];
                    current.hash = current.hash.replace('#', '/');
                }
            }

            var rootStripper = rootRouter.options.root && new RegExp("^" + rootRouter.options.root + "/");

            $(document).delegate("a", 'click', function (evt) {
                if (history._hasPushState) {
                    if (!evt.altKey && !evt.ctrlKey && !evt.metaKey && !evt.shiftKey && rootRouter.targetIsThisWindow(evt)) {
                        var href = $(this).attr("href");

                        // Ensure the protocol is not part of URL, meaning its relative.
                        // Stop the event bubbling to ensure the link will not cause a page refresh.
                        if (href != null && !(href.charAt(0) === "#" || /^[a-z]+:/i.test(href))) {
                            evt.preventDefault();

                            if (rootStripper) {
                                href = href.replace(rootStripper, "");
                            }

                            history.navigate(href);
                        }
                    }
                }
            });

            if (history.options.silent && startDeferred) {
                startDeferred.resolve();
                startDeferred = null;
            }
        }).promise();
    };

    /**
     * Disable history, perhaps temporarily. Not useful in a real app, but possibly useful for unit testing Routers.
     * @method deactivate
     */
    rootRouter.deactivate = function () {
        history.deactivate();
    };

    /**
     * Installs the router's custom ko binding handler.
     * @method install
     */
    rootRouter.install = function () {
        ko.bindingHandlers.router = {
            init: function () {
                return { controlsDescendantBindings: true };
            },
            update: function (element, valueAccessor, allBindingsAccessor, viewModel, bindingContext) {
                var settings = ko.utils.unwrapObservable(valueAccessor()) || {};

                if (settings.__router__) {
                    settings = {
                        model: settings.activeItem(),
                        attached: settings.attached,
                        compositionComplete: settings.compositionComplete,
                        activate: false
                    };
                } else {
                    var theRouter = ko.utils.unwrapObservable(settings.router || viewModel.router) || rootRouter;
                    settings.model = theRouter.activeItem();
                    settings.attached = theRouter.attached;
                    settings.compositionComplete = theRouter.compositionComplete;
                    settings.activate = false;
                }

                composition.compose(element, settings, bindingContext);
            }
        };

        ko.virtualElements.allowedBindings.router = true;
    };

    return rootRouter;
});
