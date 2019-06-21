const express = require('express');
const router = express.Router();
const colors = require('colors');
const randtoken = require('rand-token');
const bcrypt = require('bcryptjs');
const common = require('../lib/common');

// insert a customer
router.post('/customer/create', (req, res) => {
    const db = req.app.db;

    let doc = {
        email: req.body.email,
        firstName: req.body.firstName,
        lastName: req.body.lastName,
        address1: req.body.address1,
        address2: req.body.address2,
        country: req.body.country,
        state: req.body.state,
        postcode: req.body.postcode,
        phone: req.body.phone,
        password: bcrypt.hashSync(req.body.password, 10),
        created: new Date()
    };

    // check for existing customer
    db.customers.findOne({email: req.body.email}, (err, customer) => {
        if(customer){
            res.status(404).json({
                err: 'A customer already exists with that email address'
            });
            return;
        }
        // email is ok to be used.
        db.customers.insertOne(doc, (err, newCustomer) => {
            if(err){
                if(newCustomer){
                    console.error(colors.red('Failed to insert customer: ' + err));
                    res.status(400).json({
                        err: 'Клієнт вже існує з цією адресою електронної пошти'
                    });
                    return;
                }
                console.error(colors.red('Не вдалося вставити клієнта: ' + err));
                res.status(400).json({
                    err: '\n' + 'Помилка створення клієнта.'
                });
                return;
            }

            // Customer creation successful
            req.session.customer = newCustomer.ops[0];
            res.status(200).json({
                message: 'Успішний вхід',
                customer: newCustomer
            });
        });
    });
});

// render the customer view
router.get('/admin/customer/view/:id?', common.restrict, (req, res) => {
    const db = req.app.db;

    db.customers.findOne({_id: common.getId(req.params.id)}, (err, result) => {
        if(err){
            console.info(err.stack);
        }

        res.render('customer', {
            title: 'View customer',
            result: result,
            admin: true,
            session: req.session,
            message: common.clearSessionValue(req.session, 'message'),
            messageType: common.clearSessionValue(req.session, 'messageType'),
            config: req.app.config,
            editor: true,
            helpers: req.handlebars.helpers
        });
    });
});

// customers list
router.get('/admin/customers', common.restrict, (req, res) => {
    const db = req.app.db;

    db.customers.find({}).limit(20).sort({created: -1}).toArray((err, customers) => {
        res.render('customers', {
            title: 'Customers - List',
            admin: true,
            customers: customers,
            session: req.session,
            helpers: req.handlebars.helpers,
            message: common.clearSessionValue(req.session, 'message'),
            messageType: common.clearSessionValue(req.session, 'messageType'),
            config: req.app.config
        });
    });
});

// Filtered customers list
router.get('/admin/customers/filter/:search', common.restrict, (req, res, next) => {
    const db = req.app.db;
    let searchTerm = req.params.search;
    let customersIndex = req.app.customersIndex;

    let lunrIdArray = [];
    customersIndex.search(searchTerm).forEach((id) => {
        lunrIdArray.push(common.getId(id.ref));
    });

    // we search on the lunr indexes
    db.customers.find({_id: {$in: lunrIdArray}}).sort({created: -1}).toArray((err, customers) => {
        if(err){
            console.error(colors.red('Error searching', err));
        }
        res.render('customers', {
            title: 'Customer results',
            customers: customers,
            admin: true,
            config: req.app.config,
            session: req.session,
            searchTerm: searchTerm,
            message: common.clearSessionValue(req.session, 'message'),
            messageType: common.clearSessionValue(req.session, 'messageType'),
            helpers: req.handlebars.helpers
        });
    });
});

// login the customer and check the password
router.post('/customer/login_action', async (req, res) => {
    let db = req.app.db;

    db.customers.findOne({email: common.mongoSanitize(req.body.loginEmail)}, (err, customer) => { // eslint-disable-line
        if(err){
            // An error accurred
            return res.status(400).json({
                message: 'Access denied. Check password and try again.'
            });
        }

        // check if customer exists with that email
        if(customer === undefined || customer === null){
            return res.status(400).json({
                message: 'Клієнта з цим повідомленням не існує.'
            });
        }
        // we have a customer under that email so we compare the password
        bcrypt.compare(req.body.loginPassword, customer.password)
        .then((result) => {
            if(!result){
                // password is not correct
                return res.status(400).json({
                    message: '\n' + 'Доступ заборонено. Перевірте пароль і повторіть спробу.'
                });
            }

            // Customer login successful
            req.session.customer = customer;
            return res.status(200).json({
                message: '\n' +
                    'Успішний вхід',
                customer: customer
            });
        })
        .catch((err) => {
            return res.status(400).json({
                message: '\n' +
                    'Доступ заборонено. Перевірте пароль і повторіть спробу.'
            });
        });
    });
});

// customer forgotten password
router.get('/customer/forgotten', (req, res) => {
    res.render('forgotten', {
        title: 'Forgotten',
        route: 'customer',
        forgotType: 'customer',
        config: req.app.config,
        helpers: req.handlebars.helpers,
        message: common.clearSessionValue(req.session, 'message'),
        messageType: common.clearSessionValue(req.session, 'messageType'),
        showFooter: 'showFooter'
    });
});

// forgotten password
router.post('/customer/forgotten_action', (req, res) => {
    const db = req.app.db;
    const config = req.app.config;
    let passwordToken = randtoken.generate(30);

    // find the user
    db.customers.findOne({email: req.body.email}, (err, customer) => {
        // if we have a customer, set a token, expiry and email it
        if(customer){
            let tokenExpiry = Date.now() + 3600000;
            db.customers.update({email: req.body.email}, {$set: {resetToken: passwordToken, resetTokenExpiry: tokenExpiry}}, {multi: false}, (err, numReplaced) => {
                // send forgotten password email
                let mailOpts = {
                    to: req.body.email,
                    subject: 'Forgotten password request',
                    body: `Ви отримуєте це, оскільки ви (або хтось інший) запросили скинути пароль для вашого облікового запису користувача.\n\n
                        Натисніть наведене нижче посилання або вставте його у свій веб-переглядач, щоб завершити процес:\n\n
                        ${config.baseUrl}/customer/reset/${passwordToken}\n\n
                        Якщо ви не подали запит, проігноруйте це повідомлення, і пароль залишиться без змін.\n`
                };

                // send the email with token to the user
                // TODO: Should fix this to properly handle result
                common.sendEmail(mailOpts.to, mailOpts.subject, mailOpts.body);
                req.session.message = 'An email has been sent to ' + req.body.email + ' \n' + 'з подальшими інструкціями';
                req.session.message_type = 'success';
                return res.redirect('/customer/forgotten');
            });
        }else{
            req.session.message = 'Обліковий запис не існує';
            res.redirect('/customer/forgotten');
        }
    });
});

// reset password form
router.get('/customer/reset/:token', (req, res) => {
    const db = req.app.db;

    // Find the customer using the token
    db.customers.findOne({resetToken: req.params.token, resetTokenExpiry: {$gt: Date.now()}}, (err, customer) => {
        if(!customer){
            req.session.message = '\n' + 'Маркер скидання пароля недійсний або закінчився';
            req.session.message_type = 'небезпеки';
            res.redirect('/forgot');
            return;
        }

        // show the password reset form
        res.render('reset', {
            title: '\n' + 'Скинути пароль',
            token: req.params.token,
            route: 'customer',
            config: req.app.config,
            message: common.clearSessionValue(req.session, 'message'),
            message_type: common.clearSessionValue(req.session, 'message_type'),
            show_footer: 'show_footer',
            helpers: req.handlebars.helpers
        });
    });
});

// reset password action
router.post('/customer/reset/:token', (req, res) => {
    const db = req.app.db;

    // get the customer
    db.customers.findOne({resetToken: req.params.token, resetTokenExpiry: {$gt: Date.now()}}, (err, customer) => {
        if(!customer){
            req.session.message = '\n' + 'Маркер скидання пароля недійсний або закінчився';
            req.session.message_type = '\n' + 'небезпеки';
            return res.redirect('/forgot');
        }

        // update the password and remove the token
        let newPassword = bcrypt.hashSync(req.body.password, 10);
        db.customers.update({email: customer.email}, {$set: {password: newPassword, resetToken: undefined, resetTokenExpiry: undefined}}, {multi: false}, (err, numReplaced) => {
            let mailOpts = {
                to: customer.email,
                subject: '\n' + 'Пароль успішно скинутий',
                body: '\n' + 'Це підтвердження, що пароль для вашого облікового запису ' + customer.email + ' \n' + 'нещодавно успішно змінено.\n'
            };

            // TODO: Should fix this to properly handle result
            common.sendEmail(mailOpts.to, mailOpts.subject, mailOpts.body);
            req.session.message = 'Пароль успішно оновлено';
            req.session.message_type = '\n' + 'успіх';
            return res.redirect('/pay');
        });
        return'';
    });
});

// logout the customer
router.post('/customer/logout', (req, res) => {
    req.session.customer = null;
    res.status(200).json({});
});

module.exports = router;
