const express = require('express');
const router = express.Router();
const colors = require('colors');
const async = require('async');
const _ = require('lodash');
const common = require('../lib/common');

// These is the customer facing routes
router.get('/payment/:orderId', async (req, res, next) => {
    let db = req.app.db;
    let config = req.app.config;

    // render the payment complete message
    db.orders.findOne({_id: common.getId(req.params.orderId)}, async (err, order) => {
        if(err){
            console.info(err.stack);
        }

        // If stock management is turned on payment approved update stock level
        if(config.trackStock && req.session.paymentApproved){
            order.orderProducts.forEach(async (product) => {
                const dbProduct = await db.products.findOne({_id: common.getId(product.productId)});
                let newStockLevel = dbProduct.productStock - product.quantity;
                if(newStockLevel < 1){
                    newStockLevel = 0;
                }

                // Update product stock
                await db.products.update({
                    _id: common.getId(product.productId)
                }, {
                    $set: {
                        productStock: newStockLevel
                    }
                }, {multi: false});
            });
        }

        res.render(`${config.themeViews}payment_complete`, {
            title: 'Оплата завершена',
            config: req.app.config,
            session: req.session,
            pageCloseBtn: common.showCartCloseBtn('payment'),
            result: order,
            message: common.clearSessionValue(req.session, 'message'),
            messageType: common.clearSessionValue(req.session, 'messageType'),
            helpers: req.handlebars.helpers,
            showFooter: 'showFooter',
            menu: common.sortMenu(await common.getMenu(db))
        });
    });
});

router.get('/checkout', async (req, res, next) => {
    let config = req.app.config;

    // if there is no items in the cart then render a failure
    if(!req.session.cart){
        req.session.message = 'У вашому кошику немає елементів. Додайте деякі елементи перед тим, як вийти';
        req.session.messageType = '\n' + 'небезпека';
        res.redirect('/');
        return;
    }

    // render the checkout
    res.render(`${config.themeViews}checkout`, {
        title: 'Checkout',
        config: req.app.config,
        session: req.session,
        pageCloseBtn: common.showCartCloseBtn('checkout'),
        checkout: 'hidden',
        page: 'checkout',
        message: common.clearSessionValue(req.session, 'message'),
        messageType: common.clearSessionValue(req.session, 'messageType'),
        helpers: req.handlebars.helpers,
        showFooter: 'showFooter'
    });
});

router.get('/pay', async (req, res, next) => {
    const config = req.app.config;

    // if there is no items in the cart then render a failure
    if(!req.session.cart){
        req.session.message = '\n' + 'У вашому кошику немає елементів. Додайте деякі елементи перед тим, як вийти';
        req.session.messageType = 'небезпека';
        res.redirect('/checkout');
        return;
    }

    // render the payment page
    res.render(`${config.themeViews}pay`, {
        title: 'Pay',
        config: req.app.config,
        paymentConfig: common.getPaymentConfig(),
        pageCloseBtn: common.showCartCloseBtn('pay'),
        session: req.session,
        paymentPage: true,
        page: 'pay',
        message: common.clearSessionValue(req.session, 'message'),
        messageType: common.clearSessionValue(req.session, 'messageType'),
        helpers: req.handlebars.helpers,
        showFooter: 'showFooter'
    });
});

router.get('/cartPartial', (req, res) => {
    const config = req.app.config;

    res.render(`${config.themeViews}cart`, {
        pageCloseBtn: common.showCartCloseBtn(req.query.path),
        page: req.query.path,
        layout: false,
        helpers: req.handlebars.helpers,
        config: req.app.config,
        session: req.session
    });
});

// show an individual product
router.get('/product/:id', (req, res) => {
    let db = req.app.db;
    let config = req.app.config;

    db.products.findOne({$or: [{_id: common.getId(req.params.id)}, {productPermalink: req.params.id}]}, (err, result) => {
        // render 404 if page is not published
        if(err){
            res.render('error', {title: 'Not found', message: 'Продукт не знайдено', helpers: req.handlebars.helpers, config});
        }
        if(err || result == null || result.productPublished === 'false'){
            res.render('error', {title: 'не знайдено', message: 'Продукт не знайдено', helpers: req.handlebars.helpers, config});
        }else{
            let productOptions = {};
            if(result.productOptions){
                productOptions = JSON.parse(result.productOptions);
            }

            // If JSON query param return json instead
            if(req.query.json === 'true'){
                res.status(200).json(result);
                return;
            }

            // show the view
            common.getImages(result._id, req, res, async (images) => {
                res.render(`${config.themeViews}product`, {
                    title: result.productTitle,
                    result: result,
                    productOptions: productOptions,
                    images: images,
                    productDescription: result.productDescription,
                    metaDescription: config.cartTitle + ' - ' + result.productTitle,
                    pageCloseBtn: common.showCartCloseBtn('product'),
                    config: config,
                    session: req.session,
                    pageUrl: config.baseUrl + req.originalUrl,
                    message: common.clearSessionValue(req.session, 'message'),
                    messageType: common.clearSessionValue(req.session, 'messageType'),
                    helpers: req.handlebars.helpers,
                    showFooter: 'showFooter',
                    menu: common.sortMenu(await common.getMenu(db))
                });
            });
        }
    });
});

// Updates a single product quantity
router.post('/product/updatecart', (req, res, next) => {
    const db = req.app.db;
    const config = req.app.config;
    let cartItems = JSON.parse(req.body.items);
    let hasError = false;
    let stockError = false;

    async.eachSeries(cartItems, (cartItem, callback) => {
        let productQuantity = cartItem.itemQuantity ? cartItem.itemQuantity : 1;
        if(cartItem.itemQuantity === 0){
            // quantity equals zero so we remove the item
            req.session.cart.splice(cartItem.cartIndex, 1);
            callback(null);
        }else{
            db.products.findOne({_id: common.getId(cartItem.productId)}, (err, product) => {
                if(err){
                    console.error(colors.red('Error updating cart', err));
                }
                if(product){
                    // If stock management on check there is sufficient stock for this product
                    if(config.trackStock){
                        if(productQuantity > product.productStock){
                            hasError = true;
                            stockError = true;
                            callback(null);
                            return;
                        }
                    }

                    let productPrice = parseFloat(product.productPrice).toFixed(2);
                    if(req.session.cart[cartItem.cartIndex]){
                        req.session.cart[cartItem.cartIndex].quantity = productQuantity;
                        req.session.cart[cartItem.cartIndex].totalItemPrice = productPrice * productQuantity;
                        callback(null);
                    }
                }else{
                    hasError = true;
                    callback(null);
                }
            });
        }
    }, () => {
        // update total cart amount
        common.updateTotalCartAmount(req, res);

        // show response
        if(hasError === false){
            res.status(200).json({message: '\n' +
                    'Кошик оновлено', totalCartItems: Object.keys(req.session.cart).length});
        }else{
            if(stockError){
                res.status(400).json({message: 'Запасів цього продукту недостатньо.', totalCartItems: Object.keys(req.session.cart).length});
            }else{
                res.status(400).json({message: '\n' + 'Під час оновлення кошика сталася помилка', totalCartItems: Object.keys(req.session.cart).length});
            }
        }
    });
});

// Remove single product from cart
router.post('/product/removefromcart', (req, res, next) => {
    // remove item from cart
    async.each(req.session.cart, (item, callback) => {
        if(item){
            if(item.productId === req.body.cart_index){
                req.session.cart = _.pull(req.session.cart, item);
            }
        }
        callback();
    }, () => {
        // update total cart amount
        common.updateTotalCartAmount(req, res);
        res.status(200).json({message: 'Продукт успішно видалено', totalCartItems: Object.keys(req.session.cart).length});
    });
});

// Totally empty the cart
router.post('/product/emptycart', (req, res, next) => {
    delete req.session.cart;
    delete req.session.orderId;

    // update total cart amount
    common.updateTotalCartAmount(req, res);
    res.status(200).json({message: '\n' + 'Кошик успішно спорожнений', totalCartItems: 0});
});

// Add item to cart
router.post('/product/addtocart', (req, res, next) => {
    const db = req.app.db;
    const config = req.app.config;
    let productQuantity = req.body.productQuantity ? parseInt(req.body.productQuantity) : 1;
    const productComment = req.body.productComment ? req.body.productComment : null;

    // Don't allow negative quantity
    if(productQuantity < 0){
        productQuantity = 1;
    }

    // setup cart object if it doesn't exist
    if(!req.session.cart){
        req.session.cart = [];
    }

    // Get the item from the DB
    db.products.findOne({_id: common.getId(req.body.productId)}, (err, product) => {
        if(err){
            console.error(colors.red('Помилка додавання до кошика', err));
            return res.status(400).json({message: 'Помилка оновлення кошика. Будь ласка спробуйте ще раз.'});
        }

        // No product found
        if(!product){
            return res.status(400).json({message: 'Помилка оновлення кошика. Будь ласка спробуйте ще раз.'});
        }

        // If stock management on check there is sufficient stock for this product
        if(config.trackStock){
            if(productQuantity > product.productStock){
                return res.status(400).json({message: 'Запасів цього продукту недостатньо.'});
            }
        }

        let productPrice = parseFloat(product.productPrice).toFixed(2);

        // Doc used to test if existing in the cart with the options. If not found, we add new.
        let options = {};
        if(req.body.productOptions){
            options = JSON.parse(req.body.productOptions);
        }
        let findDoc = {
            productId: req.body.productId,
            options: options
        };

        // if exists we add to the existing value
        let cartIndex = _.findIndex(req.session.cart, findDoc);
        if(cartIndex > -1){
            req.session.cart[cartIndex].quantity = parseInt(req.session.cart[cartIndex].quantity) + productQuantity;
            req.session.cart[cartIndex].totalItemPrice = productPrice * parseInt(req.session.cart[cartIndex].quantity);
        }else{
            // Doesnt exist so we add to the cart session
            req.session.cartTotalItems = req.session.cartTotalItems + productQuantity;

            // new product deets
            let productObj = {};
            productObj.productId = req.body.productId;
            productObj.title = product.productTitle;
            productObj.quantity = productQuantity;
            productObj.totalItemPrice = productPrice * productQuantity;
            productObj.options = options;
            productObj.productImage = product.productImage;
            productObj.productComment = productComment;
            if(product.productPermalink){
                productObj.link = product.productPermalink;
            }else{
                productObj.link = product._id;
            }

            // merge into the current cart
            req.session.cart.push(productObj);
        }

        // update total cart amount
        common.updateTotalCartAmount(req, res);

        // update how many products in the shopping cart
        req.session.cartTotalItems = req.session.cart.reduce((a, b) => +a + +b.quantity, 0);
        return res.status(200).json({message: 'Кошик оновлено', totalCartItems: req.session.cartTotalItems});
    });
});

// search products
router.get('/search/:searchTerm/:pageNum?', (req, res) => {
    let db = req.app.db;
    let searchTerm = req.params.searchTerm;
    let productsIndex = req.app.productsIndex;
    let config = req.app.config;
    let numberProducts = config.productsPerPage ? config.productsPerPage : 6;

    let lunrIdArray = [];
    productsIndex.search(searchTerm).forEach((id) => {
        lunrIdArray.push(common.getId(id.ref));
    });

    let pageNum = 1;
    if(req.params.pageNum){
        pageNum = req.params.pageNum;
    }

    Promise.all([
        common.getData(req, pageNum, {_id: {$in: lunrIdArray}}),
        common.getMenu(db)
    ])
    .then(([results, menu]) => {
        // If JSON query param return json instead
        if(req.query.json === 'true'){
            res.status(200).json(results.data);
            return;
        }

        res.render(`${config.themeViews}index`, {
            title: 'Results',
            results: results.data,
            filtered: true,
            session: req.session,
            metaDescription: req.app.config.cartTitle + ' - \n' + 'Термін пошуку: ' + searchTerm,
            searchTerm: searchTerm,
            pageCloseBtn: common.showCartCloseBtn('search'),
            message: common.clearSessionValue(req.session, 'message'),
            messageType: common.clearSessionValue(req.session, 'messageType'),
            productsPerPage: numberProducts,
            totalProductCount: results.totalProducts,
            pageNum: pageNum,
            paginateUrl: 'search',
            config: config,
            menu: common.sortMenu(menu),
            helpers: req.handlebars.helpers,
            showFooter: 'showFooter'
        });
    })
    .catch((err) => {
        console.error(colors.red('\n' + 'Помилка пошуку продуктів', err));
    });
});

// search products
router.get('/category/:cat/:pageNum?', (req, res) => {
    let db = req.app.db;
    let searchTerm = req.params.cat;
    let productsIndex = req.app.productsIndex;
    let config = req.app.config;
    let numberProducts = config.productsPerPage ? config.productsPerPage : 6;

    let lunrIdArray = [];
    productsIndex.search(searchTerm).forEach((id) => {
        lunrIdArray.push(common.getId(id.ref));
    });

    let pageNum = 1;
    if(req.params.pageNum){
        pageNum = req.params.pageNum;
    }

    Promise.all([
        common.getData(req, pageNum, {_id: {$in: lunrIdArray}}),
        common.getMenu(db)
    ])
    .then(([results, menu]) => {
        const sortedMenu = common.sortMenu(menu);

        // If JSON query param return json instead
        if(req.query.json === 'true'){
            res.status(200).json(results.data);
            return;
        }

        res.render(`${config.themeViews}index`, {
            title: 'Category',
            results: results.data,
            filtered: true,
            session: req.session,
            searchTerm: searchTerm,
            metaDescription: req.app.config.cartTitle + ' - Category: ' + searchTerm,
            pageCloseBtn: common.showCartCloseBtn('category'),
            message: common.clearSessionValue(req.session, 'message'),
            messageType: common.clearSessionValue(req.session, 'messageType'),
            productsPerPage: numberProducts,
            totalProductCount: results.totalProducts,
            pageNum: pageNum,
            menuLink: _.find(sortedMenu.items, (obj) => { return obj.link === searchTerm; }),
            paginateUrl: 'category',
            config: config,
            menu: sortedMenu,
            helpers: req.handlebars.helpers,
            showFooter: 'showFooter'
        });
    })
    .catch((err) => {
        console.error(colors.red('Помилка отримання продуктів для категорії', err));
    });
});

// return sitemap
router.get('/sitemap.xml', (req, res, next) => {
    let sm = require('sitemap');
    let config = req.app.config;

    common.addSitemapProducts(req, res, (err, products) => {
        if(err){
            console.error(colors.red('Error generating sitemap.xml', err));
        }
        let sitemap = sm.createSitemap(
            {
                hostname: config.baseUrl,
                cacheTime: 600000,
                urls: [
                    {url: '/', changefreq: 'weekly', priority: 1.0}
                ]
            });

        let currentUrls = sitemap.urls;
        let mergedUrls = currentUrls.concat(products);
        sitemap.urls = mergedUrls;
        // render the sitemap
        sitemap.toXML((err, xml) => {
            if(err){
                return res.status(500).end();
            }
            res.header('Content-Type', 'application/xml');
            res.send(xml);
            return true;
        });
    });
});

router.get('/page/:pageNum', (req, res, next) => {
    let db = req.app.db;
    let config = req.app.config;
    let numberProducts = config.productsPerPage ? config.productsPerPage : 6;

    Promise.all([
        common.getData(req, req.params.pageNum),
        common.getMenu(db)
    ])
    .then(([results, menu]) => {
        // If JSON query param return json instead
        if(req.query.json === 'true'){
            res.status(200).json(results.data);
            return;
        }

        res.render(`${config.themeViews}index`, {
            title: 'Shop',
            results: results.data,
            session: req.session,
            message: common.clearSessionValue(req.session, 'message'),
            messageType: common.clearSessionValue(req.session, 'messageType'),
            metaDescription: req.app.config.cartTitle + ' - Products page: ' + req.params.pageNum,
            pageCloseBtn: common.showCartCloseBtn('page'),
            config: req.app.config,
            productsPerPage: numberProducts,
            totalProductCount: results.totalProducts,
            pageNum: req.params.pageNum,
            paginateUrl: 'page',
            helpers: req.handlebars.helpers,
            showFooter: 'showFooter',
            menu: common.sortMenu(menu)
        });
    })
    .catch((err) => {
        console.error(colors.red('Помилка отримання товарів для сторінки', err));
    });
});

// The main entry point of the shop
router.get('/:page?', (req, res, next) => {
    let db = req.app.db;
    let config = req.app.config;
    let numberProducts = config.productsPerPage ? config.productsPerPage : 6;

    // if no page is specified, just render page 1 of the cart
    if(!req.params.page){
        Promise.all([
            common.getData(req, 1, {}),
            common.getMenu(db)
        ])
        .then(([results, menu]) => {
            // If JSON query param return json instead
            if(req.query.json === 'true'){
                res.status(200).json(results.data);
                return;
            }

            res.render(`${config.themeViews}index`, {
                title: `${config.cartTitle} - Shop`,
                theme: config.theme,
                results: results.data,
                session: req.session,
                message: common.clearSessionValue(req.session, 'message'),
                messageType: common.clearSessionValue(req.session, 'messageType'),
                pageCloseBtn: common.showCartCloseBtn('page'),
                config: req.app.config,
                productsPerPage: numberProducts,
                totalProductCount: results.totalProducts,
                pageNum: 1,
                paginateUrl: 'page',
                helpers: req.handlebars.helpers,
                showFooter: 'showFooter',
                menu: common.sortMenu(menu)
            });
        })
        .catch((err) => {
            console.error(colors.red('\n' + 'Помилка отримання товарів для сторінки', err));
        });
    }else{
        if(req.params.page === 'admin'){
            next();
            return;
        }
        // lets look for a page
        db.pages.findOne({pageSlug: req.params.page, pageEnabled: 'true'}, async (err, page) => {
            if(err){
                console.error(colors.red('Помилка отримання сторінки', err));
            }
            // if we have a page lets render it, else throw 404
            if(page){
                res.render(`${config.themeViews}page`, {
                    title: page.pageName,
                    page: page,
                    searchTerm: req.params.page,
                    session: req.session,
                    message: common.clearSessionValue(req.session, 'message'),
                    messageType: common.clearSessionValue(req.session, 'messageType'),
                    pageCloseBtn: common.showCartCloseBtn('page'),
                    config: req.app.config,
                    metaDescription: req.app.config.cartTitle + ' - ' + page,
                    helpers: req.handlebars.helpers,
                    showFooter: 'showFooter',
                    menu: common.sortMenu(await common.getMenu(db))
                });
            }else{
                res.status(404).render('error', {
                    title: 'Помилка 404 - сторінку не знайдено',
                    config: req.app.config,
                    message: 'Помилка 404 - сторінку не знайдено',
                    helpers: req.handlebars.helpers,
                    showFooter: 'showFooter',
                    menu: common.sortMenu(await common.getMenu(db))
                });
            }
        });
    }
});

module.exports = router;
