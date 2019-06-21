const express = require('express');
const common = require('../lib/common');
const escape = require('html-entities').AllHtmlEntities;
const colors = require('colors');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const glob = require('glob');
const mime = require('mime-type/with-db');
const router = express.Router();

// Admin section
router.get('/admin', common.restrict, (req, res, next) => {
    res.redirect('/admin/orders');
});

// logout
router.get('/admin/logout', (req, res) => {
    req.session.user = null;
    req.session.message = null;
    req.session.messageType = null;
    res.redirect('/');
});

// login form
router.get('/admin/login', (req, res) => {
    let db = req.app.db;

    db.users.count({}, (err, userCount) => {
        if(err){
            // if there are no users set the "needsSetup" session
            req.session.needsSetup = true;
            res.redirect('/admin/setup');
        }
        // we check for a user. If one exists, redirect to login form otherwise setup
        if(userCount > 0){
            // set needsSetup to false as a user exists
            req.session.needsSetup = false;
            res.render('login', {
                title: 'Login',
                referringUrl: req.header('Referer'),
                config: req.app.config,
                message: common.clearSessionValue(req.session, 'message'),
                messageType: common.clearSessionValue(req.session, 'messageType'),
                helpers: req.handlebars.helpers,
                showFooter: 'showFooter'
            });
        }else{
            // if there are no users set the "needsSetup" session
            req.session.needsSetup = true;
            res.redirect('/admin/setup');
        }
    });
});

// login the user and check the password
router.post('/admin/login_action', (req, res) => {
    let db = req.app.db;

    db.users.findOne({userEmail: common.mongoSanitize(req.body.email)}, (err, user) => {
        if(err){
            res.status(400).json({message: '\n' + 'Користувача з цією електронною поштою не існує.'});
            return;
        }

        // check if user exists with that email
        if(user === undefined || user === null){
            res.status(400).json({message: 'Користувача з цією електронною поштою не існує.'});
        }else{
            // we have a user under that email so we compare the password
            bcrypt.compare(req.body.password, user.userPassword)
            .then((result) => {
                if(result){
                    req.session.user = req.body.email;
                    req.session.usersName = user.usersName;
                    req.session.userId = user._id.toString();
                    req.session.isAdmin = user.isAdmin;
                    res.status(200).json({message: '\n' + 'Вхід успішний'});
                }else{
                    // password is not correct
                    res.status(400).json({message: 'Доступ заборонено. Перевірте пароль і повторіть спробу.'});
                }
            });
        }
    });
});

// setup form is shown when there are no users setup in the DB
router.get('/admin/setup', (req, res) => {
    let db = req.app.db;

    db.users.count({}, (err, userCount) => {
        if(err){
            console.error(colors.red('\n' + 'Помилка отримання користувачів для налаштування', err));
        }
        // dont allow the user to "re-setup" if a user exists.
        // set needsSetup to false as a user exists
        req.session.needsSetup = false;
        if(userCount === 0){
            req.session.needsSetup = true;
            res.render('setup', {
                title: 'Setup',
                config: req.app.config,
                helpers: req.handlebars.helpers,
                message: common.clearSessionValue(req.session, 'message'),
                messageType: common.clearSessionValue(req.session, 'messageType'),
                showFooter: 'showFooter'
            });
        }else{
            res.redirect('/admin/login');
        }
    });
});

// insert a user
router.post('/admin/setup_action', (req, res) => {
    const db = req.app.db;

    let doc = {
        usersName: req.body.usersName,
        userEmail: req.body.userEmail,
        userPassword: bcrypt.hashSync(req.body.userPassword, 10),
        isAdmin: true
    };

    // check for users
    db.users.count({}, (err, userCount) => {
        if(err){
            console.info(err.stack);
        }
        if(userCount === 0){
            // email is ok to be used.
            db.users.insert(doc, (err, doc) => {
                // show the view
                if(err){
                    console.error(colors.red('Не вдалося вставити користувача: ' + err));
                    req.session.message = 'Не вдалося встановити програму';
                    req.session.messageType = 'небезпеки';
                    res.redirect('/admin/setup');
                }else{
                    req.session.message = 'Вставлено обліковий запис користувача';
                    req.session.messageType = 'успіх';
                    res.redirect('/admin/login');
                }
            });
        }else{
            res.redirect('/admin/login');
        }
    });
});

// settings update
router.get('/admin/settings', common.restrict, (req, res) => {
    res.render('settings', {
        title: 'Cart settings',
        session: req.session,
        admin: true,
        themes: common.getThemes(),
        message: common.clearSessionValue(req.session, 'message'),
        messageType: common.clearSessionValue(req.session, 'messageType'),
        helpers: req.handlebars.helpers,
        config: req.app.config,
        footerHtml: typeof req.app.config.footerHtml !== 'undefined' ? escape.decode(req.app.config.footerHtml) : null,
        googleAnalytics: typeof req.app.config.googleAnalytics !== 'undefined' ? escape.decode(req.app.config.googleAnalytics) : null
    });
});

// settings update
router.post('/admin/settings/update', common.restrict, common.checkAccess, (req, res) => {
    let result = common.updateConfig(req.body);
    if(result === true){
        res.status(200).json({message: 'Налаштування успішно оновлено'});
        res.configDirty = true;
        return;
    }
    res.status(400).json({message: '\n' + 'Дозволи заборонено'});
});

// settings update
router.post('/admin/settings/option/remove', common.restrict, common.checkAccess, (req, res) => {
    const db = req.app.db;
    db.products.findOne({_id: common.getId(req.body.productId)}, (err, product) => {
        if(err){
            console.info(err.stack);
        }
        if(product && product.productOptions){
            let optJson = JSON.parse(product.productOptions);
            delete optJson[req.body.optName];

            db.products.update({_id: common.getId(req.body.productId)}, {$set: {productOptions: JSON.stringify(optJson)}}, (err, numReplaced) => {
                if(err){
                    console.info(err.stack);
                }
                if(numReplaced.result.nModified === 1){
                    res.status(200).json({message: 'Варіант успішно видалено'});
                }else{
                    res.status(400).json({message: 'Не вдалося видалити параметр. Будь ласка спробуйте ще раз.'});
                }
            });
        }else{
            res.status(400).json({message: 'Продукт не знайдено. Спробуйте зберегти перед видаленням.'});
        }
    });
});

// settings update
router.get('/admin/settings/menu', common.restrict, async (req, res) => {
    const db = req.app.db;
    res.render('settings_menu', {
        title: 'Cart menu',
        session: req.session,
        admin: true,
        message: common.clearSessionValue(req.session, 'message'),
        messageType: common.clearSessionValue(req.session, 'messageType'),
        helpers: req.handlebars.helpers,
        config: req.app.config,
        menu: common.sortMenu(await common.getMenu(db))
    });
});

// settings page list
router.get('/admin/settings/pages', common.restrict, (req, res) => {
    const db = req.app.db;
    db.pages.find({}).toArray(async (err, pages) => {
        if(err){
            console.info(err.stack);
        }

        res.render('settings_pages', {
            title: '\n' + 'Статичні сторінки',
            pages: pages,
            session: req.session,
            admin: true,
            message: common.clearSessionValue(req.session, 'message'),
            messageType: common.clearSessionValue(req.session, 'messageType'),
            helpers: req.handlebars.helpers,
            config: req.app.config,
            menu: common.sortMenu(await common.getMenu(db))
        });
    });
});

// settings pages new
router.get('/admin/settings/pages/new', common.restrict, common.checkAccess, async (req, res) => {
    const db = req.app.db;

    res.render('settings_page_edit', {
        title: '\n' + 'Статичні сторінки',
        session: req.session,
        admin: true,
        button_text: 'Create',
        message: common.clearSessionValue(req.session, 'message'),
        messageType: common.clearSessionValue(req.session, 'messageType'),
        helpers: req.handlebars.helpers,
        config: req.app.config,
        menu: common.sortMenu(await common.getMenu(db))
    });
});

// settings pages editor
router.get('/admin/settings/pages/edit/:page', common.restrict, common.checkAccess, (req, res) => {
    const db = req.app.db;
    db.pages.findOne({_id: common.getId(req.params.page)}, async (err, page) => {
        if(err){
            console.info(err.stack);
        }
        // page found
        const menu = common.sortMenu(await common.getMenu(db));
        if(page){
            res.render('settings_page_edit', {
                title: '\n' + 'Статичні сторінки',
                page: page,
                button_text: '\n' + 'Оновлення',
                session: req.session,
                admin: true,
                message: common.clearSessionValue(req.session, 'message'),
                messageType: common.clearSessionValue(req.session, 'messageType'),
                helpers: req.handlebars.helpers,
                config: req.app.config,
                menu
            });
        }else{
            // 404 it!
            res.status(404).render('error', {
                title: 'Помилка 404 - сторінку не знайдено',
                config: req.app.config,
                message: 'Помилка 404 - сторінку не знайдено',
                helpers: req.handlebars.helpers,
                showFooter: 'showFooter',
                menu
            });
        }
    });
});

// settings update page
router.post('/admin/settings/pages/update', common.restrict, common.checkAccess, (req, res) => {
    const db = req.app.db;

    let doc = {
        pageName: req.body.pageName,
        pageSlug: req.body.pageSlug,
        pageEnabled: req.body.pageEnabled,
        pageContent: req.body.pageContent
    };

    if(req.body.page_id){
        // existing page
        db.pages.findOne({_id: common.getId(req.body.page_id)}, (err, page) => {
            if(err){
                console.info(err.stack);
            }
            if(page){
                db.pages.update({_id: common.getId(req.body.page_id)}, {$set: doc}, {}, (err, numReplaced) => {
                    if(err){
                        console.info(err.stack);
                    }
                    res.status(200).json({message: '\n' + 'Сторінку успішно оновлено', page_id: req.body.page_id});
                });
            }else{
                res.status(400).json({message: '\n' + 'Сторінку не знайдено'});
            }
        });
    }else{
        // insert page
        db.pages.insert(doc, (err, newDoc) => {
            if(err){
                res.status(400).json({message: 'Помилка створення сторінки. Будь ласка спробуйте ще раз.'});
            }else{
                res.status(200).json({message: 'Нова сторінка успішно створена', page_id: newDoc._id});
            }
        });
    }
});

// settings delete page
router.get('/admin/settings/pages/delete/:page', common.restrict, common.checkAccess, (req, res) => {
    const db = req.app.db;
    db.pages.remove({_id: common.getId(req.params.page)}, {}, (err, numRemoved) => {
        if(err){
            req.session.message = 'Помилка видалення сторінки. Будь ласка спробуйте ще раз.';
            req.session.messageType = '\n' + 'небезпеки';
            res.redirect('/admin/settings/pages');
            return;
        }
        req.session.message = '\n' + 'Сторінку успішно видалено';
        req.session.messageType = 'success';
        res.redirect('/admin/settings/pages');
    });
});

// new menu item
router.post('/admin/settings/menu/new', common.restrict, common.checkAccess, (req, res) => {
    let result = common.newMenu(req, res);
    if(result === false){
        req.session.message = 'Не вдалося створити меню.';
        req.session.messageType = 'danger';
    }
    res.redirect('/admin/settings/menu');
});

// update existing menu item
router.post('/admin/settings/menu/update', common.restrict, common.checkAccess, (req, res) => {
    let result = common.updateMenu(req, res);
    if(result === false){
        req.session.message = 'Помилка оновлення меню.';
        req.session.messageType = 'danger';
    }
    res.redirect('/admin/settings/menu');
});

// delete menu item
router.get('/admin/settings/menu/delete/:menuid', common.restrict, common.checkAccess, (req, res) => {
    let result = common.deleteMenu(req, res, req.params.menuid);
    if(result === false){
        req.session.message = 'Failed deleting menu.';
        req.session.messageType = 'danger';
    }
    res.redirect('/admin/settings/menu');
});

// We call this via a Ajax call to save the order from the sortable list
router.post('/admin/settings/menu/save_order', common.restrict, common.checkAccess, (req, res) => {
    let result = common.orderMenu(req, res);
    if(result === false){
        res.status(400).json({message: 'Не вдалося зберегти порядок меню'});
        return;
    }
    res.status(200);
});

// validate the permalink
router.post('/admin/api/validate_permalink', (req, res) => {
    // if doc id is provided it checks for permalink in any products other that one provided,
    // else it just checks for any products with that permalink
    const db = req.app.db;

    let query = {};
    if(typeof req.body.docId === 'undefined' || req.body.docId === ''){
        query = {productPermalink: req.body.permalink};
    }else{
        query = {productPermalink: req.body.permalink, _id: {$ne: common.getId(req.body.docId)}};
    }

    db.products.count(query, (err, products) => {
        if(err){
            console.info(err.stack);
        }
        if(products > 0){
            res.status(400).json({message: '\n' + 'Постійне посилання вже існує'});
        }else{
            res.status(200).json({message: 'Постійні ссилки успішно перевірено'});
        }
    });
});

// upload the file
let upload = multer({dest: 'public/uploads/'});
router.post('/admin/file/upload', common.restrict, common.checkAccess, upload.single('upload_file'), (req, res, next) => {
    const db = req.app.db;

    if(req.file){
        let file = req.file;

        // Get the mime type of the file
        const mimeType = mime.lookup(file.originalname);
        
        // Check for allowed mime type and file size
        if(!common.allowedMimeType.includes(mimeType) || file.size > common.fileSizeLimit){
            // Remove temp file
            fs.unlinkSync(file.path);

            // Redirect to error
            req.session.message = '\n' + 'Тип файлу заборонено або занадто великий. Будь ласка спробуйте ще раз.';
            req.session.messageType = 'danger';
            res.redirect('/admin/product/edit/' + req.body.productId);
            return;
        }

        // get the product form the DB
        db.products.findOne({_id: common.getId(req.body.productId)}, (err, product) => {
            if(err){
                console.info(err.stack);
                // delete the temp file.
                fs.unlinkSync(file.path);

                // Redirect to error
                req.session.message = 'Помилка завантаження файлу. Будь ласка спробуйте ще раз.';
                req.session.messageType = 'danger';
                res.redirect('/admin/product/edit/' + req.body.productId);
                return;
            }

            const productPath = product.productPermalink;
            let uploadDir = path.join('public/uploads', productPath);

            // Check directory and create (if needed)
            common.checkDirectorySync(uploadDir);

            let source = fs.createReadStream(file.path);
            let dest = fs.createWriteStream(path.join(uploadDir, file.originalname.replace(/ /g, '_')));

            // save the new file
            source.pipe(dest);
            source.on('end', () => { });

            // delete the temp file.
            fs.unlinkSync(file.path);

            let imagePath = path.join('/uploads', productPath, file.originalname.replace(/ /g, '_'));

            // if there isn't a product featured image, set this one
            if(!product.productImage){
                db.products.update({_id: common.getId(req.body.productId)}, {$set: {productImage: imagePath}}, {multi: false}, (err, numReplaced) => {
                    if(err){
                        console.info(err.stack);
                    }
                    req.session.message = '\n' + 'Файл успішно завантажено';
                    req.session.messageType = 'success';
                    res.redirect('/admin/product/edit/' + req.body.productId);
                });
            }else{
                req.session.message = 'Файл успішно завантажено';
                req.session.messageType = 'success';
                res.redirect('/admin/product/edit/' + req.body.productId);
            }
        });
    }else{
        // delete the temp file.
        fs.unlinkSync(file.path);

        // Redirect to error
        req.session.message = '\n' + 'Помилка завантаження файлу. Виберіть файл.';
        req.session.messageType = 'danger';
        res.redirect('/admin/product/edit/' + req.body.productId);
    }
});

// delete a file via ajax request
router.post('/admin/testEmail', common.restrict, (req, res) => {
    let config = req.app.config;
    // TODO: Should fix this to properly handle result
    common.sendEmail(config.emailAddress, 'expressCart test email', '\n' + 'Налаштування електронної пошти працюють');
    res.status(200).json({message: '\n' + 'Надіслано тестове електронне повідомлення'});
});

// delete a file via ajax request
router.post('/admin/file/delete', common.restrict, common.checkAccess, (req, res) => {
    req.session.message = null;
    req.session.messageType = null;

    fs.unlink('public/' + req.body.img, (err) => {
        if(err){
            console.error(colors.red('File delete error: ' + err));
            res.writeHead(400, {'Content-Type': 'application/text'});
            res.end('Failed to delete file: ' + err);
        }else{
            res.writeHead(200, {'Content-Type': 'application/text'});
            res.end('File deleted successfully');
        }
    });
});

router.get('/admin/files', common.restrict, (req, res) => {
    // loop files in /public/uploads/
    glob('public/uploads/**', {nosort: true}, (er, files) => {
        // sort array
        files.sort();

        // declare the array of objects
        let fileList = [];
        let dirList = [];

        // loop these files
        for(let i = 0; i < files.length; i++){
            // only want files
            if(fs.lstatSync(files[i]).isDirectory() === false){
                // declare the file object and set its values
                let file = {
                    id: i,
                    path: files[i].substring(6)
                };

                // push the file object into the array
                fileList.push(file);
            }else{
                let dir = {
                    id: i,
                    path: files[i].substring(6)
                };

                // push the dir object into the array
                dirList.push(dir);
            }
        }

        // render the files route
        res.render('files', {
            title: 'Files',
            files: fileList,
            admin: true,
            dirs: dirList,
            session: req.session,
            config: common.get(),
            message: common.clearSessionValue(req.session, 'message'),
            messageType: common.clearSessionValue(req.session, 'messageType')
        });
    });
});

module.exports = router;
